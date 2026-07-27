import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	renderStickyViewportShowcase,
	STICKY_VIEWPORT_SHOWCASE_ENTRIES,
	STICKY_VIEWPORT_SHOWCASE_KEYS,
	type StickyViewportShowcaseEntry,
} from "../test/fixtures/tui/sticky-viewport-showcase";

const COMMAND =
	"bun packages/coding-agent/scripts/capture-sticky-viewport-showcase.ts --out .gjc/qa/sticky-viewport-<run>";
const REVISION = "sticky-viewport-showcase-v2";
const TIMESTAMP = "1970-01-01T00:00:00.000Z";
const PAYLOADS = ["terminal.txt", "terminal-ansi.txt", "terminal.html", "metadata.json"] as const;
const FONT_RENDERING_ASSUMPTIONS =
	"Embedded red-claw theme at deterministic truecolor; HTML uses a monospace terminal fallback stack.";
const WRAPPING_TRUNCATION_POLICY =
	"ANSI-aware terminal-cell wrapping preserves semantic CJK phrase boundaries; constrained height drops the notice, decorative pet, then low-priority hooks without truncating pinned status or the focused composer.";
const ACCEPTANCE_VERSION = "sticky-viewport-stage-03";
const DESIGN_VERSION = "modes-design-sticky-viewport-v3";
const CJK_PHRASE_BOUNDARIES = ["의미 있는 문장 경계", "意味のある文の境界", "保留语义短语边界"] as const;
const HOST_MATRIX = {
	capture_host: "VirtualTerminal",
	live_pty: false,
	network: false,
} as const;
const escapeHtml = (value: string) =>
	value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
type AnsiStyle = {
	foreground?: string;
	background?: string;
	bold?: boolean;
	dim?: boolean;
	italic?: boolean;
	underline?: boolean;
	blink?: boolean;
	inverse?: boolean;
	invisible?: boolean;
	strikethrough?: boolean;
	overline?: boolean;
};
const TERMINAL_DEFAULT_FOREGROUND = "#ffe7dc";
const TERMINAL_DEFAULT_BACKGROUND = "#110b0b";
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
/** Converts an xterm 256-color palette index into its canonical CSS color. */
export const xterm256Color = (index: number): string => {
	if (!Number.isInteger(index) || index < 0 || index > 255) throw new RangeError(`invalid xterm color index ${index}`);
	if (index < 16) return ANSI_COLORS[index < 8 ? index + 30 : index + 82]!;
	if (index >= 232) {
		const value = (index - 232) * 10 + 8;
		return `rgb(${value},${value},${value})`;
	}
	const value = index - 16,
		channel = (component: number) => (component === 0 ? 0 : component * 40 + 55);
	return `rgb(${channel(Math.floor(value / 36))},${channel(Math.floor((value % 36) / 6))},${channel(value % 6)})`;
};
const styleAttribute = (style: AnsiStyle): string => {
	const foreground = style.inverse ? (style.background ?? TERMINAL_DEFAULT_BACKGROUND) : style.foreground;
	const background = style.inverse ? (style.foreground ?? TERMINAL_DEFAULT_FOREGROUND) : style.background;
	const decorations = [
		style.underline && "underline",
		style.strikethrough && "line-through",
		style.overline && "overline",
	]
		.filter(Boolean)
		.join(" ");
	return [
		foreground && `color:${foreground}`,
		background && `background-color:${background}`,
		style.bold && "font-weight:700",
		style.dim && "opacity:.65",
		style.italic && "font-style:italic",
		style.blink && "animation:blink 1s step-end infinite",
		style.invisible && "visibility:hidden",
		decorations && `text-decoration:${decorations}`,
	]
		.filter(Boolean)
		.join(";");
};
const NON_VISUAL_TERMINAL_CONTROL = /\x1b_[^\x1b\x07]*(?:\x07|\x1b\\)/g;
/** Stateful SGR conversion with closing/reopening spans and partial/full resets. */
export function ansiToHtml(value: string): string {
	const visibleText = value.replace(NON_VISUAL_TERMINAL_CONTROL, "");
	let body = "",
		offset = 0,
		spanOpen = false,
		style: AnsiStyle = {};
	const close = () => {
		if (spanOpen) {
			body += "</span>";
			spanOpen = false;
		}
	};
	const open = () => {
		const attribute = styleAttribute(style);
		if (attribute) {
			body += `<span style="${attribute}">`;
			spanOpen = true;
		}
	};
	for (const match of visibleText.matchAll(/\x1b\[([0-9;]*)m/g)) {
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
			else if (code === 39) style.foreground = undefined;
			else if (code === 49) style.background = undefined;
			else if (code in ANSI_COLORS) style.foreground = ANSI_COLORS[code];
			else if (code >= 40 && code <= 47) style.background = ANSI_COLORS[code - 10];
			else if (code >= 100 && code <= 107) style.background = ANSI_COLORS[code - 10];
			else if (code === 38 || code === 48) {
				const mode = codes[index + 1];
				if (mode === 2 && [codes[index + 2], codes[index + 3], codes[index + 4]].every(Number.isInteger)) {
					const color = `rgb(${codes[index + 2]},${codes[index + 3]},${codes[index + 4]})`;
					if (code === 38) style.foreground = color;
					else style.background = color;
					index += 4;
				} else if (mode === 5 && Number.isInteger(codes[index + 2])) {
					if (code === 38) style.foreground = xterm256Color(codes[index + 2]!);
					else style.background = xterm256Color(codes[index + 2]!);
					index += 2;
				}
			}
		}
		open();
	}
	body += escapeHtml(visibleText.slice(offset));
	close();
	return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Sticky viewport showcase</title><style>body{margin:0;background:#110b0b;color:#ffe7dc}pre{white-space:pre;font-family:ui-monospace,monospace}@keyframes blink{50%{visibility:hidden}}</style><pre>${body}</pre></html>\n`;
}
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const hash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
function out(args: string[]): string {
	if (args.length !== 2 || args[0] !== "--out" || !args[1]) throw new Error(`Usage: ${COMMAND}`);
	return args[1];
}
async function capture(entry: StickyViewportShowcaseEntry, root: string) {
	const rendered = await renderStickyViewportShowcase(entry);
	if (!rendered.state.composer_visible)
		throw new Error(`${entry.key}: focused composer was not visible in production frame`);
	if (entry.stateId === "manual-new-output" && rendered.state.notice !== true)
		throw new Error(`${entry.key}: manual output notice precondition failed`);
	if (
		JSON.stringify(rendered.cjkPhraseBoundaries) !==
		JSON.stringify(entry.stateId === "narrow-cjk" ? CJK_PHRASE_BOUNDARIES : [])
	)
		throw new Error(`${entry.key}: CJK phrase boundary metadata precondition failed`);
	const directory = path.join(root, ...entry.key.split("/"));
	await fs.mkdir(directory, { recursive: true });
	const metadata = json({
		schema_version: 2,
		entry_key: entry.key,
		fixture_revision: REVISION,
		capture_timestamp: TIMESTAMP,
		command_or_replay_source: COMMAND,
		fixture_source: "packages/coding-agent/test/fixtures/tui/sticky-viewport-showcase.ts",
		terminal: {
			...entry.viewport,
			font_rendering_assumptions: FONT_RENDERING_ASSUMPTIONS,
			wrapping_truncation_policy: WRAPPING_TRUNCATION_POLICY,
		},
		render_mode: entry.renderMode,
		ansi_mode: entry.renderMode === "unicode-color",
		source_revision: rendered.sourceRevision,
		output_revision: rendered.outputRevision,
		state: rendered.state,
		provenance: {
			capture_mode: "production-tui-virtual-terminal",
			live_pty: false,
			network: false,
			fixed_clock: true,
			author_identity: "capture-sticky-viewport-showcase",
			executor_identity: "capture-sticky-viewport-showcase",
		},
		cjk_phrase_boundaries: rendered.cjkPhraseBoundaries,
	});
	const contents = {
		"terminal.txt": rendered.terminalText,
		"terminal-ansi.txt": rendered.terminalAnsiText,
		"terminal.html": ansiToHtml(rendered.terminalAnsiText),
		"metadata.json": metadata,
	};
	const files = await Promise.all(
		PAYLOADS.map(async name => {
			const content = contents[name];
			await Bun.write(path.join(directory, name), content);
			return {
				path: `${entry.key}/${name}`,
				sha256: hash(content),
				byte_length: Buffer.byteLength(content),
			};
		}),
	);
	return {
		key: entry.key,
		state_id: entry.stateId,
		viewport: entry.viewport,
		render_mode: entry.renderMode,
		files,
	};
}
async function main() {
	const root = path.resolve(out(process.argv.slice(2)));
	await fs.mkdir(root, { recursive: true });
	const entries = [];
	for (const entry of STICKY_VIEWPORT_SHOWCASE_ENTRIES) entries.push(await capture(entry, root));
	const manifest = json({
		schema_version: 2,
		fixture_revision: REVISION,
		command: COMMAND,
		capture_timestamp: TIMESTAMP,
		expected_entry_count: 20,
		entry_count: 20,
		ordered_keys: STICKY_VIEWPORT_SHOWCASE_KEYS,
		provenance: {
			capture_mode: "production-tui-virtual-terminal",
			live_pty: false,
			network: false,
			fixed_clock: true,
			author_identity: "capture-sticky-viewport-showcase",
			executor_identity: "capture-sticky-viewport-showcase",
		},
		review_input_file: "review-input.json",
		entries,
	});
	await Bun.write(path.join(root, "manifest.json"), manifest);
	await Bun.write(
		path.join(root, "review-input.json"),
		json({
			schema_version: 2,
			manifest_sha256: hash(manifest),
			command_or_replay_source: COMMAND,
			capture_timestamp: TIMESTAMP,
			fixture_source: "packages/coding-agent/test/fixtures/tui/sticky-viewport-showcase.ts",
			fixed_clock: true,
			live_pty: false,
			network: false,
			expected_keys: STICKY_VIEWPORT_SHOWCASE_KEYS,
			author_identity: "capture-sticky-viewport-showcase",
			executor_identity: "capture-sticky-viewport-showcase",
			required_artifacts: PAYLOADS,
			acceptance_version: ACCEPTANCE_VERSION,
			design_version: DESIGN_VERSION,
			host_matrix: HOST_MATRIX,
			narrow_cjk: {
				entry_key: "narrow-cjk/48x10/unicode-color",
				phrase_boundaries: ["의미 있는 문장 경계", "意味のある文の境界", "保留语义短语边界"],
			},
		}),
	);
	process.stdout.write(`Captured 20 production TUI sticky viewport entries to ${root}\n`);
}
if (import.meta.main) await main();
