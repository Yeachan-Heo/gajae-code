import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Resvg } from "@resvg/resvg-js";

export const TERMINAL_EVIDENCE_VERSION = "gjc-terminal-cell-grid-v1";
export const CELL_GEOMETRY = {
	cellWidthPx: 10,
	cellHeightPx: 20,
	baselinePx: 15,
	horizontalPaddingPx: 16,
	verticalPaddingPx: 16,
	devicePixelRatio: 1,
} as const;

export const LIGHT_THEME_EVIDENCE_SOURCE_PATHS = [
	"bun.lock",
	"packages/coding-agent/package.json",
	"packages/coding-agent/src/config/settings-schema.ts",
	"packages/coding-agent/src/config/settings.ts",
	"packages/coding-agent/src/modes/DESIGN.md",
	"packages/coding-agent/src/modes/components/assistant-message.ts",
	"packages/coding-agent/src/modes/components/bash-execution.ts",
	"packages/coding-agent/src/modes/components/custom-message.ts",
	"packages/coding-agent/src/modes/components/diff.ts",
	"packages/coding-agent/src/modes/components/eval-execution.ts",
	"packages/coding-agent/src/modes/components/notifications-settings-editor.ts",
	"packages/coding-agent/src/modes/components/provider-onboarding-selector.ts",
	"packages/coding-agent/src/modes/components/settings-selector.ts",
	"packages/coding-agent/src/modes/components/tool-execution.ts",
	"packages/coding-agent/src/modes/components/tool-status-header.ts",
	"packages/coding-agent/src/modes/components/tree-selector.ts",
	"packages/coding-agent/src/modes/components/user-message.ts",
	"packages/coding-agent/src/modes/components/welcome.ts",
	"packages/coding-agent/src/session/session-manager.ts",
	"packages/coding-agent/src/modes/theme/defaults/blue-crab-light.json",
	"packages/coding-agent/src/modes/theme/defaults/index.ts",
	"packages/coding-agent/src/modes/theme/defaults/red-claw-light.json",
	"packages/coding-agent/src/modes/theme/theme.ts",
	"packages/coding-agent/src/tui/status-line.ts",
	"packages/coding-agent/scripts/capture-light-theme-compliance-showcase.ts",
	"packages/coding-agent/scripts/lib/terminal-visual-evidence.ts",
	"packages/coding-agent/test/fixtures/tui/light-theme-compliance-showcase.ts",
	"packages/coding-agent/test/fixtures/tui/light-theme-consumer-atlas.ts",
	"packages/coding-agent/test/fixtures/tui/notifications-settings-showcase.ts",
	"packages/coding-agent/test/light-theme-compliance.test.ts",
] as const;

export interface SourceFingerprint {
	source_revision: string;
	source_fingerprint: string;
	source_files: readonly { path: string; sha256: string; byte_length: number }[];
}

export interface FontRecord {
	requestedFamily: string;
	resolvedFamily: string;
	postscriptName: string;
	path: string;
	version: number;
	sha256: string;
	coveredScript: "latin-terminal" | "korean" | "japanese" | "simplified-chinese";
	source: "system";
}

export interface CaptureEnvironment extends Record<string, unknown> {
	fonts: readonly FontRecord[];
	environment_id: string;
}

export interface ThemeEvidenceIdentity {
	requestedTheme: string;
	resolvedTheme: string;
	keyTheme: string;
	themeSentinelRoles: Readonly<Record<string, string>>;
	themeSentinelSha256: string;
	pageBackground: string;
}

export const CANONICAL_DARWIN_FONTS: readonly FontRecord[] = [
	{
		requestedFamily: "Menlo Regular",
		resolvedFamily: "Menlo",
		postscriptName: "Menlo-Regular",
		path: "/System/Library/Fonts/Menlo.ttc",
		version: 132907,
		sha256: "dc256e0b39c2a6fec947129d421fef41b8b429f58f9b6e5d1b148c87f775c1f6",
		coveredScript: "latin-terminal",
		source: "system",
	},
	{
		requestedFamily: "Apple SD Gothic Neo Regular",
		resolvedFamily: "Apple SD Gothic Neo",
		postscriptName: "AppleSDGothicNeo-Regular",
		path: "/System/Library/Fonts/AppleSDGothicNeo.ttc",
		version: 65536,
		sha256: "e33989af92c53dd2b80efd88f50c404094a046658d0e7a7692619587570e616c",
		coveredScript: "korean",
		source: "system",
	},
	{
		requestedFamily: "Hiragino Sans W3",
		resolvedFamily: "Hiragino Sans",
		postscriptName: "HiraginoSans-W3",
		path: "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc",
		version: 541327,
		sha256: "833776a6fd68e2c71c0c52fd8041195bd3d0a336cdb278170b7ad71c7e1b3475",
		coveredScript: "japanese",
		source: "system",
	},
	{
		requestedFamily: "PingFang SC Regular",
		resolvedFamily: "PingFang SC",
		postscriptName: "PingFangSC-Regular",
		path: "/System/Library/AssetsV2/com_apple_MobileAsset_Font8/86ba2c91f017a3749571a82f2c6d890ac7ffb2fb.asset/AssetData/PingFang.ttc",
		version: 327680,
		sha256: "9ff3ce9439fe285cdabb46f9ceb46b1ac58f1ca07e6f4a764e8286db621a0af9",
		coveredScript: "simplified-chinese",
		source: "system",
	},
] as const;

interface CellStyle {
	foreground: string;
	background: string;
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: boolean;
	inverse: boolean;
}

export interface TerminalCell extends CellStyle {
	row: number;
	column: number;
	grapheme: string;
	span: number;
	continuation: boolean;
}

export interface TerminalCellGrid {
	columns: number;
	rows: number;
	cells: readonly TerminalCell[];
	sha256: string;
	occupancySha256: string;
	plainText: string;
}

export interface PngEvidence {
	bytes: Uint8Array;
	width: number;
	height: number;
	decodedRgbaSha256: string;
	byteSha256: string;
	nonUniform: boolean;
	sentinelSamples: readonly { role: string; x: number; y: number; rgb: string }[];
}

const BASIC_COLORS: Readonly<Record<number, string>> = {
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

const OSC = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|_[^\x07\x1b]*(?:\x07|\x1b\\))/g;
const SGR = /\x1b\[([0-9;]*)m/g;
const SEGMENTER = new Intl.Segmenter("en", { granularity: "grapheme" });

export function sha256(value: string | Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

export function stableJson(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

export function computeThemeSentinelSha256(roles: Readonly<Record<string, string>>, pageBackground: string): string {
	const roleKeys = Object.keys(roles)
		.filter(role => role !== "background")
		.sort();
	const canonical = JSON.stringify({
		background: pageBackground,
		roles: Object.fromEntries(roleKeys.map(role => [role, roles[role]])),
	});
	return sha256(canonical);
}

export function assertThemeEvidenceIdentity(identity: ThemeEvidenceIdentity, expectedTheme: string): void {
	if (
		identity.requestedTheme !== expectedTheme ||
		identity.resolvedTheme !== expectedTheme ||
		identity.keyTheme !== expectedTheme
	) {
		throw new Error(
			`Theme identity mismatch: expected ${expectedTheme}, requested ${identity.requestedTheme}, resolved ${identity.resolvedTheme}, key ${identity.keyTheme}`,
		);
	}
	if (identity.themeSentinelRoles.background !== identity.pageBackground) {
		throw new Error("Theme background role does not match the page background");
	}
	const recomputed = computeThemeSentinelSha256(identity.themeSentinelRoles, identity.pageBackground);
	if (recomputed !== identity.themeSentinelSha256) {
		throw new Error(`Theme sentinel mismatch: expected ${identity.themeSentinelSha256}, recomputed ${recomputed}`);
	}
}

export function assertHtmlThemeIdentity(html: string, expectedTheme: string, expectedSentinel: string): void {
	if (!html.includes(`data-theme="${expectedTheme}"`) || !html.includes(`data-theme-sentinel="${expectedSentinel}"`)) {
		throw new Error(`HTML identity mismatch for ${expectedTheme}`);
	}
}

export async function captureSourceFingerprint(repoRoot: string): Promise<SourceFingerprint> {
	const sourceFiles: Array<{ path: string; sha256: string; byte_length: number }> = [];
	for (const relativePath of LIGHT_THEME_EVIDENCE_SOURCE_PATHS) {
		const bytes = new Uint8Array(await Bun.file(path.join(repoRoot, relativePath)).arrayBuffer());
		sourceFiles.push({ path: relativePath, sha256: sha256(bytes), byte_length: bytes.byteLength });
	}
	const git = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (git.exitCode !== 0) throw new Error(`Cannot resolve git revision: ${git.stderr.toString()}`);
	const commit = git.stdout.toString().trim();
	const source_fingerprint = sha256(stableJson(sourceFiles));
	return {
		source_revision: `${commit}+worktree:${source_fingerprint}`,
		source_fingerprint,
		source_files: sourceFiles,
	};
}

function ansi256(index: number): string {
	if (!Number.isInteger(index) || index < 0 || index > 255) throw new Error(`Invalid ANSI-256 color index: ${index}`);
	if (index < 16) {
		const color = BASIC_COLORS[index < 8 ? index + 30 : index + 82];
		if (!color) throw new Error(`Missing ANSI base color for index ${index}`);
		return color;
	}
	if (index >= 232) {
		const channel = (index - 232) * 10 + 8;
		return `#${channel.toString(16).padStart(2, "0").repeat(3)}`;
	}
	const value = index - 16;
	const channels = [Math.floor(value / 36), Math.floor((value % 36) / 6), value % 6].map(component =>
		component === 0 ? 0 : component * 40 + 55,
	);
	return `#${channels.map(channel => channel.toString(16).padStart(2, "0")).join("")}`;
}

function cloneStyle(style: CellStyle): CellStyle {
	return { ...style };
}

function applySgr(style: CellStyle, rawCodes: string): void {
	const codes = (rawCodes || "0").split(";").map(Number);
	if (codes.some(code => !Number.isInteger(code) || code < 0)) {
		throw new Error(`Invalid SGR sequence: ${rawCodes}`);
	}
	for (let index = 0; index < codes.length; index += 1) {
		const code = codes[index];
		if (code === 0) {
			style.foreground = "";
			style.background = "";
			style.bold = false;
			style.dim = false;
			style.italic = false;
			style.underline = false;
			style.inverse = false;
		} else if (code === 1) style.bold = true;
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
		else if (code === 39) style.foreground = "";
		else if (code === 49) style.background = "";
		else if (code !== undefined && BASIC_COLORS[code]) style.foreground = BASIC_COLORS[code]!;
		else if (code !== undefined && ((code >= 40 && code <= 47) || (code >= 100 && code <= 107))) {
			const color = BASIC_COLORS[code - 10];
			if (!color) throw new Error(`Missing ANSI background color for SGR ${code}`);
			style.background = color;
		} else if (code === 38 || code === 48) {
			const mode = codes[index + 1];
			let color: string;
			if (mode === 2) {
				const channels = codes.slice(index + 2, index + 5);
				if (
					channels.length !== 3 ||
					channels.some(channel => channel === undefined || channel < 0 || channel > 255)
				) {
					throw new Error(`Invalid SGR truecolor sequence: ${rawCodes}`);
				}
				color = `#${channels.map(channel => channel.toString(16).padStart(2, "0")).join("")}`;
				index += 4;
			} else if (mode === 5 && Number.isInteger(codes[index + 2])) {
				color = ansi256(codes[index + 2]!);
				index += 2;
			} else {
				throw new Error(`Unsupported SGR color sequence: ${rawCodes}`);
			}
			if (code === 38) style.foreground = color;
			else style.background = color;
		} else {
			throw new Error(`Unsupported SGR code ${String(code)} in sequence: ${rawCodes}`);
		}
	}
}

function parseStyledSegments(
	line: string,
	defaultForeground: string,
	defaultBackground: string,
): Array<{ text: string; style: CellStyle }> {
	const visible = line.replace(OSC, "");
	const style: CellStyle = {
		foreground: defaultForeground,
		background: defaultBackground,
		bold: false,
		dim: false,
		italic: false,
		underline: false,
		inverse: false,
	};
	const segments: Array<{ text: string; style: CellStyle }> = [];
	let offset = 0;
	for (const match of visible.matchAll(SGR)) {
		const text = visible.slice(offset, match.index);
		if (text) segments.push({ text, style: cloneStyle(style) });
		applySgr(style, match[1] ?? "0");
		if (!style.foreground) style.foreground = defaultForeground;
		if (!style.background) style.background = defaultBackground;
		offset = (match.index ?? 0) + match[0].length;
	}
	const tail = visible.slice(offset);
	if (tail) segments.push({ text: tail, style: cloneStyle(style) });
	return segments;
}

export function parseAnsiCellGrid(
	ansi: string,
	columns: number,
	rows: number,
	defaultForeground: string,
	defaultBackground: string,
): TerminalCellGrid {
	const inputLines = ansi.replace(/\r\n?/g, "\n").split("\n");
	if (inputLines.at(-1) === "") inputLines.pop();
	if (inputLines.length > rows)
		throw new Error(`ANSI surface has ${inputLines.length} rows; expected at most ${rows}`);
	const cells: TerminalCell[] = [];
	const plainLines: string[] = [];
	for (let row = 0; row < rows; row += 1) {
		const line = inputLines[row] ?? "";
		let column = 0;
		let plain = "";
		for (const segment of parseStyledSegments(line, defaultForeground, defaultBackground)) {
			for (const part of SEGMENTER.segment(segment.text)) {
				const grapheme = part.segment;
				const span = Math.max(0, Bun.stringWidth(grapheme));
				if (span === 0) {
					plain += grapheme;
					continue;
				}
				if (column + span > columns)
					throw new Error(`ANSI row ${row} exceeds ${columns} cells at ${JSON.stringify(grapheme)}`);
				const foreground = segment.style.inverse ? segment.style.background : segment.style.foreground;
				const background = segment.style.inverse ? segment.style.foreground : segment.style.background;
				cells.push({
					...segment.style,
					foreground,
					background,
					row,
					column,
					grapheme,
					span,
					continuation: false,
				});
				for (let continuation = 1; continuation < span; continuation += 1) {
					cells.push({
						...segment.style,
						foreground,
						background,
						row,
						column: column + continuation,
						grapheme: "",
						span: 0,
						continuation: true,
					});
				}
				plain += grapheme;
				column += span;
			}
		}
		plainLines.push(plain);
	}
	const canonical = stableJson(
		cells.map(cell => [
			cell.row,
			cell.column,
			cell.grapheme,
			cell.span,
			cell.foreground,
			cell.background,
			cell.bold,
			cell.dim,
			cell.italic,
			cell.underline,
		]),
	);
	const occupancy = stableJson(
		cells.filter(cell => !cell.continuation).map(cell => [cell.row, cell.column, cell.span]),
	);
	return {
		columns,
		rows,
		cells,
		sha256: sha256(canonical),
		occupancySha256: sha256(occupancy),
		plainText: `${plainLines.join("\n")}\n`,
	};
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function cellGridToHtml(
	grid: TerminalCellGrid,
	themeName: string,
	sentinelSha256: string,
	pageBackground: string,
): string {
	const byRow = Array.from({ length: grid.rows }, () => [] as TerminalCell[]);
	for (const cell of grid.cells) if (!cell.continuation) byRow[cell.row]!.push(cell);
	const rows = byRow.map(row =>
		row
			.map(cell => {
				const styles = [`color:${cell.foreground}`, `background-color:${cell.background}`];
				if (cell.bold) styles.push("font-weight:700");
				if (cell.dim) styles.push("opacity:.72");
				if (cell.italic) styles.push("font-style:italic");
				if (cell.underline) styles.push("text-decoration:underline");
				return `<span data-c="${cell.column}" data-span="${cell.span}" style="${styles.join(";")}">${escapeHtml(cell.grapheme)}</span>`;
			})
			.join(""),
	);
	return `<!doctype html>\n<html lang="en" data-theme="${themeName}" data-theme-sentinel="${sentinelSha256}">\n<head><meta charset="utf-8"><meta name="color-scheme" content="light"><title>GJC light-theme TUI evidence</title><style>html,body{margin:0;background:${pageBackground};color-scheme:light}pre{margin:0;padding:16px;white-space:pre;font-family:Menlo,"Apple SD Gothic Neo","Hiragino Sans","PingFang SC",monospace;line-height:20px;font-size:16px}</style></head>\n<body><pre>${rows.join("\n")}</pre></body>\n</html>\n`;
}

function svgTextStyle(cell: TerminalCell): string {
	const parts = [`fill:${cell.foreground}`, `font-size:16px`];
	if (cell.bold) parts.push("font-weight:700");
	if (cell.italic) parts.push("font-style:italic");
	if (cell.underline) parts.push("text-decoration:underline");
	if (cell.dim) parts.push("opacity:.72");
	return parts.join(";");
}

export function cellGridToSvg(
	grid: TerminalCellGrid,
	themeName: string,
	sentinelSha256: string,
	roles: Readonly<Record<string, string>>,
	pageBackground: string,
): { svg: string; displayListSha256: string; samples: readonly { role: string; x: number; y: number; rgb: string }[] } {
	if (roles.background !== pageBackground) {
		throw new Error(`PNG background role mismatch: expected ${pageBackground}, got ${String(roles.background)}`);
	}
	const width = grid.columns * CELL_GEOMETRY.cellWidthPx + CELL_GEOMETRY.horizontalPaddingPx * 2;
	const height = grid.rows * CELL_GEOMETRY.cellHeightPx + CELL_GEOMETRY.verticalPaddingPx * 2;
	const elements: string[] = [`<rect x="0" y="0" width="${width}" height="${height}" fill="${pageBackground}"/>`];
	const orderedRoles = [
		"background",
		"text",
		"muted",
		"dim",
		"border",
		"accent",
		"selectedBg",
		"success",
		"warning",
		"error",
	] as const;
	const samples = orderedRoles.map((role, index) => {
		const x = 2 + index * 3;
		const y = 2;
		const rgb = role === "background" ? pageBackground : roles[role];
		if (!rgb) throw new Error(`Missing PNG sentinel role: ${role}`);
		elements.push(`<rect data-role="${role}" x="${x}" y="${y}" width="2" height="2" fill="${rgb}"/>`);
		return { role, x, y, rgb };
	});
	for (const cell of grid.cells) {
		if (cell.continuation) continue;
		const x = CELL_GEOMETRY.horizontalPaddingPx + cell.column * CELL_GEOMETRY.cellWidthPx;
		const y = CELL_GEOMETRY.verticalPaddingPx + cell.row * CELL_GEOMETRY.cellHeightPx;
		if (cell.background !== pageBackground) {
			elements.push(
				`<rect x="${x}" y="${y}" width="${cell.span * CELL_GEOMETRY.cellWidthPx}" height="${CELL_GEOMETRY.cellHeightPx}" fill="${cell.background}"/>`,
			);
		}
		if (cell.grapheme) {
			elements.push(
				`<text x="${x}" y="${y + CELL_GEOMETRY.baselinePx}" style="${svgTextStyle(cell)}">${escapeHtml(cell.grapheme)}</text>`,
			);
		}
	}
	const displayList = elements.join("\n");
	const displayListSha256 = sha256(displayList);
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" data-theme="${themeName}" data-theme-sentinel="${sentinelSha256}" data-display-list="${displayListSha256}"><g font-family="Menlo, Apple SD Gothic Neo, Hiragino Sans, PingFang SC, monospace" text-rendering="geometricPrecision">${displayList}</g></svg>`;
	return { svg, displayListSha256, samples };
}

function pixelHex(pixels: Uint8Array, width: number, x: number, y: number): string {
	const offset = (y * width + x) * 4;
	const channels = [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
	if (channels.some(channel => channel === undefined)) {
		throw new Error(`PNG sentinel coordinate is out of bounds: ${x},${y}`);
	}
	return `#${channels.map(channel => channel.toString(16).padStart(2, "0")).join("")}`;
}

export function rasterizeSvg(
	svg: string,
	fontFiles: readonly string[],
	samples: readonly { role: string; x: number; y: number; rgb: string }[],
): PngEvidence {
	const renderer = new Resvg(svg, {
		font: {
			loadSystemFonts: false,
			fontFiles: [...fontFiles],
			defaultFontFamily: "Menlo",
			monospaceFamily: "Menlo",
		},
		dpi: 96,
		shapeRendering: 2,
		textRendering: 2,
		imageRendering: 1,
		logLevel: "error",
	});
	const rendered = renderer.render();
	const bytes = rendered.asPng();
	const pixels = rendered.pixels;
	if (bytes[0] !== 0x89 || String.fromCharCode(...bytes.slice(1, 4)) !== "PNG")
		throw new Error("Resvg output is not PNG");
	const first = pixels.slice(0, 4).join(",");
	let nonUniform = false;
	for (let offset = 4; offset < pixels.length; offset += 4) {
		if (pixels.slice(offset, offset + 4).join(",") !== first) {
			nonUniform = true;
			break;
		}
	}
	if (!nonUniform) throw new Error("PNG evidence is uniform");
	for (const sample of samples) {
		const actual = pixelHex(pixels, rendered.width, sample.x, sample.y);
		if (actual.toLowerCase() !== sample.rgb.toLowerCase()) {
			throw new Error(`PNG sentinel ${sample.role} mismatch: expected ${sample.rgb}, got ${actual}`);
		}
	}
	return {
		bytes,
		width: rendered.width,
		height: rendered.height,
		decodedRgbaSha256: sha256(pixels),
		byteSha256: sha256(bytes),
		nonUniform,
		sentinelSamples: samples,
	};
}

export async function verifyCanonicalFonts(): Promise<readonly FontRecord[]> {
	if (process.platform !== "darwin") throw new Error("Canonical light-theme capture requires Darwin system fonts");
	for (const font of CANONICAL_DARWIN_FONTS) {
		const bytes = new Uint8Array(await Bun.file(font.path).arrayBuffer());
		const actual = sha256(bytes);
		if (actual !== font.sha256) throw new Error(`Canonical font mismatch for ${font.postscriptName}: ${actual}`);
	}
	return CANONICAL_DARWIN_FONTS;
}

async function findNativeBinary(root: string): Promise<string> {
	const entries = await fs.readdir(root, { withFileTypes: true });
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		const candidate = path.join(root, entry.name);
		if (entry.isDirectory()) {
			const found = await findNativeBinary(candidate);
			if (found) return found;
		} else if (entry.name.endsWith(".node")) return candidate;
	}
	return "";
}

function commandText(command: string[]): string {
	const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) {
		throw new Error(`Environment command failed (${command.join(" ")}): ${result.stderr.toString()}`);
	}
	return result.stdout.toString().trim();
}

export async function captureEnvironment(repoRoot: string): Promise<CaptureEnvironment> {
	const fonts = await verifyCanonicalFonts();
	if (Bun.env.TZ !== "UTC" || Bun.env.LANG !== "en_US.UTF-8" || Bun.env.LC_ALL !== "en_US.UTF-8") {
		throw new Error("Canonical capture requires TZ=UTC, LANG=en_US.UTF-8, and LC_ALL=en_US.UTF-8");
	}
	const packageRoot = path.join(repoRoot, "node_modules", "@resvg");
	const nativeBinary = await findNativeBinary(packageRoot);
	if (!nativeBinary) throw new Error("Cannot locate @resvg/resvg-js native binary");
	const lockBytes = new Uint8Array(await Bun.file(path.join(repoRoot, "bun.lock")).arrayBuffer());
	const nativeBytes = new Uint8Array(await Bun.file(nativeBinary).arrayBuffer());
	const packagePath = path.join(repoRoot, "node_modules", "@resvg", "resvg-js", "package.json");
	const packageBytes = new Uint8Array(await Bun.file(packagePath).arrayBuffer());
	const packageManifest = JSON.parse(new TextDecoder().decode(packageBytes)) as { version?: unknown };
	if (packageManifest.version !== "2.6.2") {
		throw new Error(`Unexpected @resvg/resvg-js version: ${String(packageManifest.version)}`);
	}
	const intl = Intl.DateTimeFormat().resolvedOptions();
	if (intl.timeZone !== "UTC") throw new Error(`Canonical capture resolved non-UTC time zone: ${intl.timeZone}`);
	const canonical = {
		schema_version: 1,
		os: {
			name: commandText(["sw_vers", "-productName"]),
			version: commandText(["sw_vers", "-productVersion"]),
			build: commandText(["sw_vers", "-buildVersion"]),
			platform: process.platform,
			release: os.release(),
		},
		architecture: process.arch,
		bun_version: Bun.version,
		lockfile_sha256: sha256(lockBytes),
		resvg: {
			package_version: packageManifest.version,
			package_sha256: sha256(packageBytes),
			native_binary_path: path.relative(repoRoot, nativeBinary).split(path.sep).join("/"),
			native_binary_sha256: sha256(nativeBytes),
		},
		evidence_helper_version: TERMINAL_EVIDENCE_VERSION,
		ansi_parser_version: "gjc-sgr-cell-grid-v1",
		cell_width_implementation: `Bun.stringWidth/${Bun.version}`,
		svg_serializer_version: "gjc-fixed-cell-svg-v1",
		locale: { lang: Bun.env.LANG, lc_all: Bun.env.LC_ALL, intl: intl.locale },
		time_zone: intl.timeZone,
		fonts,
		cell_geometry: CELL_GEOMETRY,
		color_profile: { name: "sRGB", source: "fixed SVG/Resvg raster contract" },
	};
	return { ...canonical, environment_id: sha256(stableJson(canonical)) };
}
