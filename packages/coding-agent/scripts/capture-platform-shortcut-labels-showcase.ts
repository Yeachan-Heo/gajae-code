import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	PLATFORM_SHORTCUT_LABELS_SHOWCASE_ENTRIES,
	PLATFORM_SHORTCUT_LABELS_SHOWCASE_EXPECTED_ENTRY_COUNT,
	type PlatformShortcutLabelsShowcaseEntry,
	renderPlatformShortcutLabelsShowcase,
} from "../test/fixtures/tui/platform-shortcut-labels-showcase";

const CANONICAL_COMMAND =
	"bun packages/coding-agent/scripts/capture-platform-shortcut-labels-showcase.ts --output .gjc/qa/platform-shortcut-labels";
const CAPTURE_TOOL_VERSION = "platform-shortcut-labels-fixture-injected-platform-v1";
const EXPECTED_KEYS = [
	"darwin/composer-idle/80x24/unicode-color",
	"darwin/composer-idle/120x36/unicode-color",
	"darwin/composer-idle/160x48/unicode-color",
	"darwin/composer-busy-effective-queue-remap/80x24/unicode-color",
	"darwin/composer-busy-effective-queue-remap/120x36/unicode-color",
	"darwin/composer-busy-effective-queue-remap/160x48/unicode-color",
	"darwin/status-effective-remap-unbound/80x24/unicode-color",
	"darwin/status-effective-remap-unbound/120x36/unicode-color",
	"darwin/status-effective-remap-unbound/160x48/unicode-color",
	"darwin/welcome-flow/80x24/unicode-color",
	"darwin/welcome-flow/120x36/unicode-color",
	"darwin/welcome-flow/160x48/unicode-color",
	"win32/composer-idle/80x24/unicode-color",
	"win32/composer-idle/120x36/unicode-color",
	"win32/composer-busy-effective-queue-remap/80x24/unicode-color",
	"win32/composer-busy-effective-queue-remap/120x36/unicode-color",
	"win32/status-effective-remap-unbound/80x24/unicode-color",
	"win32/status-effective-remap-unbound/120x36/unicode-color",
	"win32/welcome-flow/80x24/unicode-color",
	"win32/welcome-flow/120x36/unicode-color",
	"linux/composer-idle/80x24/unicode-color",
	"linux/composer-idle/120x36/unicode-color",
	"linux/composer-busy-effective-queue-remap/80x24/unicode-color",
	"linux/composer-busy-effective-queue-remap/120x36/unicode-color",
	"linux/status-effective-remap-unbound/80x24/unicode-color",
	"linux/status-effective-remap-unbound/120x36/unicode-color",
	"linux/welcome-flow/80x24/unicode-color",
	"linux/welcome-flow/120x36/unicode-color",
	"darwin/composer-idle/80x24/ascii-no-color",
	"darwin/composer-busy-effective-queue-remap/80x24/ascii-no-color",
	"darwin/status-effective-remap-unbound/80x24/ascii-no-color",
	"darwin/welcome-flow/80x24/ascii-no-color",
	"darwin/status-effective-remap-unbound/48x36/unicode-color",
	"darwin/welcome-flow/48x36/unicode-color",
] as const;

type ArtifactFile = { path: string; sha256: string; byte_length: number };
type ManifestEntry = {
	key: string;
	platform: string;
	surface: string;
	viewport: { id: string; columns: number; rows: number };
	render_mode: string;
	capture_mode: "fixture-injected-platform";
	files: ArtifactFile[];
};

function usage(): never {
	throw new Error(`Usage: ${CANONICAL_COMMAND}`);
}
function outputPath(args: string[]): string {
	if (args.length !== 2 || args[0] !== "--output" || !args[1]) usage();
	return args[1];
}
function json(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}
function sha256(value: string): string {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}
function escapeHtml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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

/** Render emitted SGR styles as safe inline CSS without retaining terminal control codes. */
function ansiToHtml(value: string): string {
	const visibleText = value.replace(NON_VISUAL_TERMINAL_CONTROL, "");
	const sgr = /\x1b\[([0-9;]*)m/g;
	let body = "";
	let offset = 0;
	let spanOpen = false;
	let style: AnsiStyle = {};
	const close = () => {
		if (!spanOpen) return;
		body += "</span>";
		spanOpen = false;
	};
	const open = () => {
		const attribute = styleAttribute(style);
		if (!attribute) return;
		body += `<span style="${attribute}">`;
		spanOpen = true;
	};

	for (const match of visibleText.matchAll(sgr)) {
		body += escapeHtml(visibleText.slice(offset, match.index));
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
	body += escapeHtml(visibleText.slice(offset));
	close();
	return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="dark"><title>Platform shortcut labels showcase</title><style>body{margin:0;background:#110b0b;color:#ffe7dc;overflow:auto}pre{margin:0;padding:1em;white-space:pre;font-family:ui-monospace,monospace;line-height:1.2}</style></head><body><pre>${body}</pre></body></html>\n`;
}
function validateMatrix(entries: readonly PlatformShortcutLabelsShowcaseEntry[]): void {
	if (PLATFORM_SHORTCUT_LABELS_SHOWCASE_EXPECTED_ENTRY_COUNT !== 34)
		throw new Error("Expected showcase entry count must remain 34");
	if (entries.length !== PLATFORM_SHORTCUT_LABELS_SHOWCASE_EXPECTED_ENTRY_COUNT)
		throw new Error(`Showcase matrix changed: expected 34 entries, received ${entries.length}`);
	const actual = entries.map(entry => entry.key);
	if (new Set(actual).size !== actual.length) throw new Error("Showcase matrix contains duplicate entry keys");
	const expected = new Set<string>(EXPECTED_KEYS);
	const missing = EXPECTED_KEYS.filter(key => !actual.includes(key));
	const surplus = actual.filter(key => !expected.has(key));
	if (missing.length || surplus.length || actual.some((key, index) => key !== EXPECTED_KEYS[index]))
		throw new Error(
			`Showcase matrix keys differ; missing=${missing.join(",") || "none"}; surplus=${surplus.join(",") || "none"}`,
		);
}
async function writeArtifact(filePath: string, content: string, outputRoot: string): Promise<ArtifactFile> {
	await Bun.write(filePath, content);
	return {
		path: path.relative(outputRoot, filePath).split(path.sep).join("/"),
		sha256: sha256(content),
		byte_length: Buffer.byteLength(content, "utf8"),
	};
}
async function captureEntry(
	entry: PlatformShortcutLabelsShowcaseEntry,
	outputRoot: string,
	capturedAt: string,
): Promise<ManifestEntry> {
	const rendered = await renderPlatformShortcutLabelsShowcase(entry);
	const directory = path.join(outputRoot, entry.platform, entry.surface, entry.viewport.id, entry.renderMode);
	await fs.mkdir(directory, { recursive: true });
	const html = ansiToHtml(rendered.terminalAnsiText);
	const metadata = json({
		schema_version: 1,
		entry_key: entry.key,
		platform: entry.platform,
		viewport: entry.viewport,
		render_mode: entry.renderMode,
		capture_mode: rendered.captureMode,
		platform_provenance: rendered.platformProvenance,
		key_display_context: rendered.keyDisplayContext,
		components: rendered.components,
		capture_timestamp: capturedAt,
		command_or_replay_source: CANONICAL_COMMAND,
		fixture_source: "packages/coding-agent/test/fixtures/tui/platform-shortcut-labels-showcase.ts",
		tool_version: CAPTURE_TOOL_VERSION,
		terminal: {
			columns: entry.viewport.columns,
			rows: entry.viewport.rows,
			font_rendering_assumptions:
				"Embedded red-claw truecolor theme; HTML uses a monospace terminal fallback stack.",
			wrapping_policy:
				"Real components render at the recorded terminal-cell width; CJK content is retained for width review.",
			ansi_control_semantics:
				"terminal-ansi.txt preserves emitted SGR sequences; terminal.txt strips them; ascii-no-color strips styling only.",
		},
		provenance: {
			platform: "fixture-injected-platform",
			live_capture: false,
			native_platform_claim: entry.platform === "darwin" ? "none (fixture only)" : "none",
		},
		fixed_clock_timestamp: rendered.fixedClockTimestamp,
	});
	const files = await Promise.all([
		writeArtifact(path.join(directory, "terminal.txt"), rendered.terminalText, outputRoot),
		writeArtifact(path.join(directory, "terminal-ansi.txt"), rendered.terminalAnsiText, outputRoot),
		writeArtifact(path.join(directory, "terminal.html"), html, outputRoot),
		writeArtifact(path.join(directory, "metadata.json"), metadata, outputRoot),
	]);
	return {
		key: entry.key,
		platform: entry.platform,
		surface: entry.surface,
		viewport: entry.viewport,
		render_mode: entry.renderMode,
		capture_mode: rendered.captureMode,
		files,
	};
}
async function main(): Promise<void> {
	const root = path.resolve(outputPath(process.argv.slice(2)));
	const capturedAt = new Date().toISOString();
	validateMatrix(PLATFORM_SHORTCUT_LABELS_SHOWCASE_ENTRIES);
	await fs.mkdir(root, { recursive: true });
	const entries: ManifestEntry[] = [];
	for (const entry of PLATFORM_SHORTCUT_LABELS_SHOWCASE_ENTRIES)
		entries.push(await captureEntry(entry, root, capturedAt));
	const manifest = json({
		schema_version: 1,
		capture_tool: CAPTURE_TOOL_VERSION,
		capture_mode: "fixture-injected-platform",
		command: CANONICAL_COMMAND,
		capture_timestamp: capturedAt,
		expected_entry_count: 34,
		entry_count: entries.length,
		ordered_keys: EXPECTED_KEYS,
		provenance: "fixture-injected-platform",
		review_input_file: "visual-review-input.json",
		entries,
	});
	const manifestSha256 = sha256(manifest);
	await Bun.write(path.join(root, "manifest.json"), manifest);
	await Bun.write(
		path.join(root, "visual-review-input.json"),
		json({
			schema_version: 1,
			manifest_sha256: manifestSha256,
			expected_manifest_entries: 34,
			ordered_keys: EXPECTED_KEYS,
			evidence_scope: {
				component_surface: "Real CustomEditor, StatusLineComponent, and WelcomeComponent rendering.",
				operations_boundary: "Fixed clock, in-memory settings, and explicit injected KeyDisplayContext platform.",
				external_effects: "No network, filesystem settings, daemon, or live native platform capture is invoked.",
			},
			review_requirements: [
				"Inspect every recorded key.",
				"Confirm Darwin glyphs and ASCII/no-color variants retain the same labels.",
				"Confirm CJK and terminal-cell width evidence in both 48x36 entries.",
				"Confirm all platform provenance is fixture-injected-platform.",
			],
			required_feature_cases: [
				{
					id: "darwin-composer",
					entry_key: "darwin/composer-idle/80x24/unicode-color",
					focus: "Darwin modifier and Enter glyph labels.",
				},
				{
					id: "effective-remap",
					entry_key: "darwin/status-effective-remap-unbound/80x24/unicode-color",
					focus: "Effective remap and unbound action labels.",
				},
				{ id: "cjk-width", entry_key: "darwin/welcome-flow/48x36/unicode-color", focus: "CJK width and wrapping." },
			],
		}),
	);
	process.stdout.write(
		`Captured ${entries.length} deterministic platform shortcut showcase entries to ${root}\nmanifest.json sha256: ${manifestSha256}\n`,
	);
}
await main();
