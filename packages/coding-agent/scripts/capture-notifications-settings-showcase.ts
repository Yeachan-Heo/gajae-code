import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	NOTIFICATIONS_SETTINGS_SHOWCASE_ENTRIES,
	NOTIFICATIONS_SETTINGS_SHOWCASE_EXPECTED_ENTRY_COUNT,
	NOTIFICATIONS_SETTINGS_SHOWCASE_STATE_IDS,
	NOTIFICATIONS_SETTINGS_SHOWCASE_TARGETED_UNICODE_VARIANTS,
	NOTIFICATIONS_SETTINGS_SHOWCASE_VIEWPORTS,
	type NotificationsSettingsShowcaseEntry,
	renderNotificationsSettingsShowcase,
} from "../test/fixtures/tui/notifications-settings-showcase";

const CANONICAL_COMMAND =
	"bun packages/coding-agent/scripts/capture-notifications-settings-showcase.ts --output .gjc/qa/issue-2050-notifications";
const DETERMINISTIC_CAPTURE_TIMESTAMP = "1970-01-01T00:00:00.000Z";
const CAPTURE_TOOL_VERSION = "notifications-settings-showcase-live-settings-selector-v3";

interface ArtifactFile {
	path: string;
	sha256: string;
	byte_length: number;
}

interface ManifestEntry {
	key: string;
	state_id: string;
	viewport: {
		id: string;
		columns: number;
		rows: number;
	};
	render_mode: string;
	capture_mode: "live-settings-selector";
	files: ArtifactFile[];
}

interface VisualReviewInput {
	schema_version: 1;
	manifest_sha256: string;
	expected_manifest_entries: number;
	evidence_scope: {
		component_surface: string;
		operations_boundary: string;
		external_effects: string;
	};
	reviewer_output_file: "independent-review.json";
	review_requirements: string[];
	required_feature_cases: Array<{
		id: string;
		entry_key: string;
		focus: string;
	}>;
}

function usage(): never {
	throw new Error(`Usage: ${CANONICAL_COMMAND}`);
}

function parseOutputPath(args: string[]): string {
	if (args.length !== 2 || args[0] !== "--output" || !args[1]) usage();
	return args[1];
}

function json(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(text: string): string {
	return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

type AnsiStyle = {
	foreground?: string;
	background?: string;
	bold?: boolean;
	dim?: boolean;
	italic?: boolean;
	underline?: boolean;
	inverse?: boolean;
};

const ANSI_COLORS: Record<number, string> = {
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

function ansi256Color(index: number): string {
	if (index < 16) return ANSI_COLORS[index < 8 ? index + 30 : index + 82] ?? "#ffffff";
	if (index >= 232) {
		const value = (index - 232) * 10 + 8;
		return `rgb(${value},${value},${value})`;
	}
	const value = index - 16;
	const red = Math.floor(value / 36);
	const green = Math.floor((value % 36) / 6);
	const blue = value % 6;
	const channel = (component: number) => (component === 0 ? 0 : component * 40 + 55);
	return `rgb(${channel(red)},${channel(green)},${channel(blue)})`;
}

function styleAttribute(style: AnsiStyle): string {
	const declarations: string[] = [];
	if (style.foreground) declarations.push(`color:${style.foreground}`);
	if (style.background) declarations.push(`background-color:${style.background}`);
	if (style.bold) declarations.push("font-weight:700");
	if (style.dim) declarations.push("opacity:.65");
	if (style.italic) declarations.push("font-style:italic");
	if (style.underline) declarations.push("text-decoration:underline");
	if (style.inverse) declarations.push("filter:invert(1)");
	return declarations.join(";");
}

const NON_VISUAL_TERMINAL_CONTROL = /\x1b_[^\x1b\x07]*(?:\x07|\x1b\\)/g;

/** Render the SGR styles emitted by the live editor without retaining raw control codes in HTML. */
function ansiToHtml(text: string): string {
	const visibleText = text.replace(NON_VISUAL_TERMINAL_CONTROL, "");
	const sgr = /\x1b\[([0-9;]*)m/g;
	let html = "";
	let offset = 0;
	let spanOpen = false;
	let style: AnsiStyle = {};
	const close = () => {
		if (!spanOpen) return;
		html += "</span>";
		spanOpen = false;
	};
	const open = () => {
		const attribute = styleAttribute(style);
		if (!attribute) return;
		html += `<span style="${attribute}">`;
		spanOpen = true;
	};

	for (const match of visibleText.matchAll(sgr)) {
		html += escapeHtml(visibleText.slice(offset, match.index));
		offset = (match.index ?? 0) + match[0].length;
		close();
		const codes = (match[1] || "0").split(";").map(Number);
		for (let index = 0; index < codes.length; index += 1) {
			const code = codes[index];
			if (code === 0) style = {};
			else if (code === 1) style.bold = true;
			else if (code === 2) style.dim = true;
			else if (code === 3) style.italic = true;
			else if (code === 4) style.underline = true;
			else if (code === 7) style.inverse = true;
			else if (code === 22) {
				style.bold = false;
				style.dim = false;
			} else if (code === 23) style.italic = false;
			else if (code === 24) style.underline = false;
			else if (code === 27) style.inverse = false;
			else if (code === 39) style.foreground = undefined;
			else if (code === 49) style.background = undefined;
			else if (code in ANSI_COLORS) style.foreground = ANSI_COLORS[code];
			else if (code >= 40 && code <= 47) style.background = ANSI_COLORS[code - 10];
			else if (code >= 100 && code <= 107) style.background = ANSI_COLORS[code - 10];
			else if (code === 38 || code === 48) {
				const colorMode = codes[index + 1];
				if (colorMode === 2) {
					const red = codes[index + 2];
					const green = codes[index + 3];
					const blue = codes[index + 4];
					if ([red, green, blue].every(Number.isInteger)) {
						if (code === 38) style.foreground = `rgb(${red},${green},${blue})`;
						else style.background = `rgb(${red},${green},${blue})`;
					}
					index += 4;
				} else if (colorMode === 5 && Number.isInteger(codes[index + 2])) {
					if (code === 38) style.foreground = ansi256Color(codes[index + 2]!);
					else style.background = ansi256Color(codes[index + 2]!);
					index += 2;
				}
			}
		}
		open();
	}
	close();
	html += escapeHtml(visibleText.slice(offset));
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="dark">
<title>Notifications settings showcase</title>
<style>body{margin:0;background:#110b0b;color:#ffe7dc}pre{margin:0;padding:1em;white-space:pre-wrap;font-family:ui-monospace,monospace;line-height:1.2}</style>
</head>
<body><pre>${html}</pre></body>
</html>
`;
}

const TELEGRAM_TOKEN_CANARY = /\d{6,}:[A-Za-z0-9_-]{20,}/;

function assertNoSecretCanary(artifacts: Readonly<Record<string, string>>): void {
	for (const [name, content] of Object.entries(artifacts)) {
		if (TELEGRAM_TOKEN_CANARY.test(content)) throw new Error(`Secret-shaped Telegram token found in ${name}`);
	}
}

function validateShowcaseMatrix(entries: readonly NotificationsSettingsShowcaseEntry[]): void {
	const expectedBaselineCount =
		NOTIFICATIONS_SETTINGS_SHOWCASE_STATE_IDS.length * NOTIFICATIONS_SETTINGS_SHOWCASE_VIEWPORTS.length;
	if (expectedBaselineCount !== 102) {
		throw new Error(`Baseline matrix changed: expected 102 entries, received ${expectedBaselineCount}`);
	}
	if (entries.length !== NOTIFICATIONS_SETTINGS_SHOWCASE_EXPECTED_ENTRY_COUNT) {
		throw new Error(
			`Showcase matrix changed: expected ${NOTIFICATIONS_SETTINGS_SHOWCASE_EXPECTED_ENTRY_COUNT} entries, received ${entries.length}`,
		);
	}
	const keys = new Set(entries.map(entry => entry.key));
	if (keys.size !== entries.length) throw new Error("Showcase matrix contains duplicate entry keys");

	for (const stateId of NOTIFICATIONS_SETTINGS_SHOWCASE_STATE_IDS) {
		for (const viewport of NOTIFICATIONS_SETTINGS_SHOWCASE_VIEWPORTS) {
			const key = `${stateId}/${viewport.id}/unicode-color`;
			if (!keys.has(key)) throw new Error(`Showcase matrix is missing ${key}`);
		}
	}

	const expectedAsciiKeys = new Set([
		"home-configured-inactive/80x24/ascii-no-color",
		"health-warning/80x24/ascii-no-color",
		"foreign-blocked/120x36/ascii-no-color",
		"confirmation-remove/80x24/ascii-no-color",
	]);
	const actualAsciiKeys = entries.filter(entry => entry.renderMode === "ascii-no-color").map(entry => entry.key);
	if (actualAsciiKeys.length !== expectedAsciiKeys.size || actualAsciiKeys.some(key => !expectedAsciiKeys.has(key))) {
		throw new Error("Showcase matrix does not contain the required ASCII/no-color variants");
	}

	const expectedNarrowKeys = new Set(
		NOTIFICATIONS_SETTINGS_SHOWCASE_TARGETED_UNICODE_VARIANTS.map(
			variant => `${variant.stateId}/${variant.viewport.id}/unicode-color`,
		),
	);
	const actualNarrowKeys = entries
		.filter(entry => entry.viewport.id === "48x36" && entry.renderMode === "unicode-color")
		.map(entry => entry.key);
	if (
		actualNarrowKeys.length !== expectedNarrowKeys.size ||
		actualNarrowKeys.some(key => !expectedNarrowKeys.has(key))
	) {
		throw new Error("Showcase matrix does not contain the required narrow CJK and scroll variants");
	}
}

async function writeArtifact(filePath: string, content: string, outputRoot: string): Promise<ArtifactFile> {
	await Bun.write(filePath, content);
	return {
		path: path.relative(outputRoot, filePath).split(path.sep).join("/"),
		sha256: sha256(content),
		byte_length: Buffer.byteLength(content, "utf8"),
	};
}

async function captureEntry(entry: NotificationsSettingsShowcaseEntry, outputRoot: string): Promise<ManifestEntry> {
	const rendered = await renderNotificationsSettingsShowcase(entry);
	const entryDirectory = path.join(outputRoot, entry.stateId, entry.viewport.id, entry.renderMode);
	await fs.mkdir(entryDirectory, { recursive: true });

	const terminalHtml = ansiToHtml(rendered.terminalAnsiText);
	const metadata = json({
		schema_version: 1,
		entry_key: entry.key,
		state_id: entry.stateId,
		viewport: entry.viewport,
		render_mode: entry.renderMode,
		capture_mode: rendered.captureMode,
		capture_timestamp: DETERMINISTIC_CAPTURE_TIMESTAMP,
		command_or_replay_source: CANONICAL_COMMAND,
		fixture_source: "packages/coding-agent/test/fixtures/tui/notifications-settings-showcase.ts",
		tool_version: CAPTURE_TOOL_VERSION,
		terminal: {
			columns: entry.viewport.columns,
			rows: entry.viewport.rows,
			font_rendering_assumptions:
				"Embedded red-claw theme at deterministic truecolor; HTML uses a monospace terminal fallback stack.",
			wrapping_policy:
				"SettingsSelectorComponent renders the Notifications tab; status labels remain on one line and status guidance wraps with ANSI-aware terminal-cell width handling.",
			ansi_control_semantics:
				"terminal-ansi.txt preserves emitted SGR sequences; terminal.txt and ascii-no-color captures strip them.",
		},
		selector_render: {
			component: "SettingsSelectorComponent",
			active_tab: rendered.selectorTab,
			notifications_editor: "NotificationsSettingsEditorComponent",
			operations: "deterministic in-memory NotificationsEditorOperations adapter; live components only",
			fixed_clock_timestamp: rendered.fixedClockTimestamp,
			navigation: rendered.navigation,
			state: rendered.state,
		},
	});
	assertNoSecretCanary({
		"terminal.txt": rendered.terminalText,
		"terminal-ansi.txt": rendered.terminalAnsiText,
		"terminal.html": terminalHtml,
		"metadata.json": metadata,
	});

	const files = await Promise.all([
		writeArtifact(path.join(entryDirectory, "terminal.txt"), rendered.terminalText, outputRoot),
		writeArtifact(path.join(entryDirectory, "terminal-ansi.txt"), rendered.terminalAnsiText, outputRoot),
		writeArtifact(path.join(entryDirectory, "terminal.html"), terminalHtml, outputRoot),
		writeArtifact(path.join(entryDirectory, "metadata.json"), metadata, outputRoot),
	]);

	return {
		key: entry.key,
		state_id: entry.stateId,
		viewport: entry.viewport,
		render_mode: entry.renderMode,
		capture_mode: rendered.captureMode,
		files,
	};
}

function visualReviewInput(manifestSha256: string): VisualReviewInput {
	return {
		schema_version: 1,
		manifest_sha256: manifestSha256,
		expected_manifest_entries: NOTIFICATIONS_SETTINGS_SHOWCASE_EXPECTED_ENTRY_COUNT,
		evidence_scope: {
			component_surface:
				"Live SettingsSelectorComponent and NotificationsSettingsEditorComponent rendering and input routing.",
			operations_boundary:
				"Deterministic in-memory NotificationsEditorOperations adapter with fixed clock and no fixture filesystem I/O.",
			external_effects: "No network, daemon, settings-file, or provider operation is invoked by this capture.",
		},
		reviewer_output_file: "independent-review.json",
		review_requirements: [
			"Inspect every manifest entry at its recorded viewport and render mode.",
			"Confirm CJK wrapping, action-list position, and selected-row visibility in both 48x36 entries.",
			"Confirm blocked restore/retain remains visible without resolving it in the rendered evidence.",
			"Confirm no terminal, HTML, or metadata artifact contains a secret-shaped Telegram token.",
		],
		required_feature_cases: [
			{
				id: "chat-entry",
				entry_key: "setup-chat-entry/80x24/unicode-color",
				focus: "Optional private-chat entry is focused before masked token entry.",
			},
			{
				id: "preferences",
				entry_key: "preferences/80x24/unicode-color",
				focus: "Safe scalar preferences remain an unsaved draft until explicit save.",
			},
			{
				id: "blocked-restore-retain",
				entry_key: "blocked-restore-retain/120x36/unicode-color",
				focus: "Both explicit CAS restore and retain-inactive choices remain visible.",
			},
			{
				id: "no-health-load",
				entry_key: "no-health-load/80x24/unicode-color",
				focus: "Initial status/health failure is rendered with recovery controls still available.",
			},
			{
				id: "narrow-cjk",
				entry_key: "narrow-cjk/48x36/unicode-color",
				focus: "Korean, Japanese, and Chinese guidance wraps without clipping wide characters.",
			},
			{
				id: "narrow-scroll",
				entry_key: "narrow-scroll/48x36/unicode-color",
				focus: "The final home action and 11/11 list position remain visible in a narrow viewport.",
			},
		],
	};
}

async function main(): Promise<void> {
	const outputRoot = path.resolve(parseOutputPath(process.argv.slice(2)));
	validateShowcaseMatrix(NOTIFICATIONS_SETTINGS_SHOWCASE_ENTRIES);
	await fs.mkdir(outputRoot, { recursive: true });

	const entries: ManifestEntry[] = [];
	for (const entry of NOTIFICATIONS_SETTINGS_SHOWCASE_ENTRIES) {
		entries.push(await captureEntry(entry, outputRoot));
	}

	const manifest = json({
		schema_version: 1,
		capture_tool: CAPTURE_TOOL_VERSION,
		capture_mode: "live-settings-selector",
		command: CANONICAL_COMMAND,
		expected_entry_count: NOTIFICATIONS_SETTINGS_SHOWCASE_EXPECTED_ENTRY_COUNT,
		entry_count: entries.length,
		matrix: {
			canonical_state_ids: NOTIFICATIONS_SETTINGS_SHOWCASE_STATE_IDS,
			viewports: NOTIFICATIONS_SETTINGS_SHOWCASE_VIEWPORTS,
			baseline_render_mode: "unicode-color",
			ascii_no_color_variant_count: 4,
			targeted_unicode_variants: NOTIFICATIONS_SETTINGS_SHOWCASE_TARGETED_UNICODE_VARIANTS,
		},
		evidence_scope: {
			component_surface:
				"Live SettingsSelectorComponent and NotificationsSettingsEditorComponent rendering and input routing.",
			operations_boundary:
				"Deterministic in-memory NotificationsEditorOperations adapter with fixed clock and no fixture filesystem I/O.",
			external_effects: "No network, daemon, settings-file, or provider operation is invoked by this capture.",
		},
		review_input_file: "visual-review-input.json",
		entries,
	});
	const manifestSha256 = sha256(manifest);
	await Bun.write(path.join(outputRoot, "manifest.json"), manifest);
	await Bun.write(path.join(outputRoot, "visual-review-input.json"), json(visualReviewInput(manifestSha256)));

	process.stdout.write(
		`Captured ${entries.length} deterministic Notifications settings-selector showcase entries to ${outputRoot}\nmanifest.json sha256: ${manifestSha256}\nreview input: visual-review-input.json\n`,
	);
}

await main();
