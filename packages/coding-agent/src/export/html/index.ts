import * as syncFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentState } from "@gajae-code/agent-core";
import { APP_NAME, isEnoent } from "@gajae-code/utils";
import { getResolvedThemeColors, getThemeExportColors } from "../../modes/theme/theme";
import { SessionManager } from "../../session/session-manager";
// Pre-generated template (created by scripts/generate-template.ts at publish time)
import { TEMPLATE } from "./template.generated";

export interface ExportOptions {
	outputPath?: string;
	themeName?: string;
}

/** Parse a color string to RGB values. */
function parseColor(color: string): { r: number; g: number; b: number } | undefined {
	const hexMatch = color.match(/^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
	if (hexMatch) {
		return {
			r: Number.parseInt(hexMatch[1], 16),
			g: Number.parseInt(hexMatch[2], 16),
			b: Number.parseInt(hexMatch[3], 16),
		};
	}
	const rgbMatch = color.match(/^rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
	if (rgbMatch) {
		return {
			r: Number.parseInt(rgbMatch[1], 10),
			g: Number.parseInt(rgbMatch[2], 10),
			b: Number.parseInt(rgbMatch[3], 10),
		};
	}
	return undefined;
}

/** Calculate relative luminance of a color (0-1, higher = lighter). */
function getLuminance(r: number, g: number, b: number): number {
	const toLinear = (c: number) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** Adjust color brightness. */
function adjustBrightness(color: string, factor: number): string {
	const parsed = parseColor(color);
	if (!parsed) return color;
	const adjust = (c: number) => Math.min(255, Math.max(0, Math.round(c * factor)));
	return `rgb(${adjust(parsed.r)}, ${adjust(parsed.g)}, ${adjust(parsed.b)})`;
}

/** Derive export background colors from a base color. */
function deriveExportColors(baseColor: string): { pageBg: string; cardBg: string; infoBg: string } {
	const parsed = parseColor(baseColor);
	if (!parsed) {
		return { pageBg: "rgb(24, 24, 30)", cardBg: "rgb(30, 30, 36)", infoBg: "rgb(60, 55, 40)" };
	}

	const luminance = getLuminance(parsed.r, parsed.g, parsed.b);
	if (luminance > 0.5) {
		return {
			pageBg: adjustBrightness(baseColor, 0.96),
			cardBg: baseColor,
			infoBg: `rgb(${Math.min(255, parsed.r + 10)}, ${Math.min(255, parsed.g + 5)}, ${Math.max(0, parsed.b - 20)})`,
		};
	}
	return {
		pageBg: adjustBrightness(baseColor, 0.7),
		cardBg: adjustBrightness(baseColor, 0.85),
		infoBg: `rgb(${Math.min(255, parsed.r + 20)}, ${Math.min(255, parsed.g + 15)}, ${parsed.b})`,
	};
}

/** Generate CSS custom properties for theme. */
async function generateThemeVars(themeName?: string): Promise<string> {
	const colors = await getResolvedThemeColors(themeName);
	const lines: string[] = [];
	for (const [key, value] of Object.entries(colors)) {
		lines.push(`--${key}: ${value};`);
	}

	const themeExport = await getThemeExportColors(themeName);
	const userMessageBg = colors.userMessageBg || "#343541";
	const derived = deriveExportColors(userMessageBg);

	lines.push(`--body-bg: ${themeExport.pageBg ?? derived.pageBg};`);
	lines.push(`--container-bg: ${themeExport.cardBg ?? derived.cardBg};`);
	lines.push(`--info-bg: ${themeExport.infoBg ?? derived.infoBg};`);

	return lines.join(" ");
}

class Base64StreamEncoder {
	#carry = Buffer.alloc(0);

	write(value: string): string {
		const incoming = Buffer.from(value, "utf8");
		const bytes = this.#carry.byteLength === 0 ? incoming : Buffer.concat([this.#carry, incoming]);
		const completeLength = bytes.byteLength - (bytes.byteLength % 3);
		this.#carry = bytes.subarray(completeLength);
		return completeLength === 0 ? "" : bytes.subarray(0, completeLength).toString("base64");
	}

	finish(): string {
		const final = this.#carry.toString("base64");
		this.#carry = Buffer.alloc(0);
		return final;
	}
}

async function canonicalizeExportPath(target: string, symlinks = new Set<string>()): Promise<string> {
	const resolved = path.resolve(target);
	const tail: string[] = [];
	let current = resolved;
	while (true) {
		try {
			const real = await fs.realpath(current);
			return tail.length === 0 ? real : path.join(real, ...tail.reverse());
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		const stat = await fs.lstat(current).catch(error => {
			if (isEnoent(error)) return undefined;
			throw error;
		});
		if (stat?.isSymbolicLink()) {
			if (symlinks.has(current)) throw new Error("HTML export path contains a symlink loop");
			const linkTarget = await fs.readlink(current);
			return canonicalizeExportPath(
				path.resolve(path.dirname(current), linkTarget, ...tail.slice().reverse()),
				new Set([...symlinks, current]),
			);
		}
		const parent = path.dirname(current);
		if (parent === current) return resolved;
		tail.push(path.basename(current));
		current = parent;
	}
}

async function assertExportDoesNotAliasSource(sourcePath: string, outputPath: string): Promise<void> {
	const sourceResolvedPath = await canonicalizeExportPath(sourcePath);
	const outputResolvedPath = await canonicalizeExportPath(outputPath);
	if (sourceResolvedPath === outputResolvedPath)
		throw new Error("HTML export output must not overwrite the source transcript");

	const sourceIdentity = await fs.stat(sourcePath).catch(error => {
		if (isEnoent(error)) return undefined;
		throw error;
	});
	const outputIdentity = await fs.stat(outputPath).catch(error => {
		if (isEnoent(error)) return undefined;
		throw error;
	});
	if (
		sourceIdentity &&
		outputIdentity &&
		sourceIdentity.dev === outputIdentity.dev &&
		sourceIdentity.ino === outputIdentity.ino
	)
		throw new Error("HTML export output must not overwrite the source transcript");
}

const HTML_EXPORT_SOURCE_OPEN_FLAGS =
	syncFs.constants.O_RDONLY |
	syncFs.constants.O_NONBLOCK |
	(process.platform === "win32" ? 0 : (syncFs.constants.O_NOFOLLOW ?? 0));

const HTML_EXPORT_DESTINATION_OPEN_FLAGS =
	syncFs.constants.O_WRONLY |
	syncFs.constants.O_CREAT |
	(process.platform === "win32" ? 0 : (syncFs.constants.O_NOFOLLOW ?? 0));

function sameFileIdentity(left: syncFs.BigIntStats, right: syncFs.BigIntStats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

async function openHtmlExportDescriptors(
	sourcePath: string | undefined,
	outputPath: string,
): Promise<{ source: number | undefined; destination: number }> {
	let source: number | undefined;
	let destination: number | undefined;
	try {
		if (sourcePath) {
			try {
				source = syncFs.openSync(sourcePath, HTML_EXPORT_SOURCE_OPEN_FLAGS);
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
			await assertExportDoesNotAliasSource(sourcePath, outputPath);
		}
		destination = syncFs.openSync(outputPath, HTML_EXPORT_DESTINATION_OPEN_FLAGS, 0o666);
		if (source !== undefined) {
			const sourceIdentity = syncFs.fstatSync(source, { bigint: true });
			const destinationIdentity = syncFs.fstatSync(destination, { bigint: true });
			if (sameFileIdentity(sourceIdentity, destinationIdentity))
				throw new Error("HTML export output must not overwrite the source transcript");
		}
		syncFs.ftruncateSync(destination, 0);
		return { source, destination };
	} catch (error) {
		if (destination !== undefined) syncFs.closeSync(destination);
		if (source !== undefined) syncFs.closeSync(source);
		throw error;
	}
}

async function writeSessionHtml(
	sm: SessionManager,
	state: AgentState | undefined,
	outputPath: string,
	themeName?: string,
): Promise<void> {
	const themeVars = await generateThemeVars(themeName);
	const themedTemplate = TEMPLATE.replace("<theme-vars/>", () => `<style>:root { ${themeVars} }</style>`);
	const marker = "{{SESSION_DATA}}";
	const markerOffset = themedTemplate.indexOf(marker);
	if (markerOffset < 0) throw new Error("HTML export template is missing the session-data marker");
	const sourcePath = sm.getSessionFile();
	const descriptors = await openHtmlExportDescriptors(sourcePath, outputPath);
	const sink = Bun.file(descriptors.destination).writer();
	const encoder = new Base64StreamEncoder();
	const writeEncoded = (value: string): void => {
		const encoded = encoder.write(value);
		if (encoded) sink.write(encoded);
	};
	try {
		sink.write(themedTemplate.slice(0, markerOffset));
		writeEncoded(`{"header":${JSON.stringify(sm.getHeader())},"entries":[`);
		let first = true;
		sm.visitEntriesForExport(entry => {
			writeEncoded(`${first ? "" : ","}${JSON.stringify(entry)}`);
			first = false;
		});
		writeEncoded(`],"leafId":${JSON.stringify(sm.getLeafId())}`);
		if (state?.systemPrompt !== undefined)
			writeEncoded(`,"systemPrompt":${JSON.stringify(state.systemPrompt.join("\n\n"))}`);
		if (state?.tools !== undefined)
			writeEncoded(
				`,"tools":${JSON.stringify(state.tools.map(tool => ({ name: tool.name, description: tool.description })))}`,
			);
		writeEncoded("}");
		const final = encoder.finish();
		if (final) sink.write(final);
		sink.write(themedTemplate.slice(markerOffset + marker.length));
		await sink.end();
	} catch (error) {
		await sink.end();
		throw error;
	} finally {
		if (descriptors.source !== undefined) syncFs.closeSync(descriptors.source);
		syncFs.closeSync(descriptors.destination);
	}
}

/** Export session to HTML using SessionManager and AgentState. */
export async function exportSessionToHtml(
	sm: SessionManager,
	state?: AgentState,
	options?: ExportOptions | string,
): Promise<string> {
	const opts: ExportOptions = typeof options === "string" ? { outputPath: options } : options || {};

	const sessionFile = sm.getSessionFile();
	if (!sessionFile) throw new Error("Cannot export in-memory session to HTML");

	const outputPath = opts.outputPath || `${APP_NAME}-session-${path.basename(sessionFile, ".jsonl")}.html`;
	await writeSessionHtml(sm, state, outputPath, opts.themeName);
	return outputPath;
}

/** Export session file to HTML (standalone). */
export async function exportFromFile(inputPath: string, options?: ExportOptions | string): Promise<string> {
	const opts: ExportOptions = typeof options === "string" ? { outputPath: options } : options || {};
	const outputPath = opts.outputPath || `${APP_NAME}-session-${path.basename(inputPath, ".jsonl")}.html`;

	let sm: SessionManager;
	const artifactRoot = inputPath.endsWith(".jsonl") ? inputPath.slice(0, -6) : inputPath;
	const hasExistingSidecars = (
		await Promise.all(
			["idx", "tail", "commit"].map(kind =>
				Bun.file(path.join(artifactRoot, `.session-memory.spill.${kind}`)).exists(),
			),
		)
	).some(Boolean);
	if (!(await Bun.file(inputPath).exists())) throw new Error(`File not found: ${inputPath}`);
	await assertExportDoesNotAliasSource(inputPath, outputPath);

	try {
		sm = await SessionManager.open(
			inputPath,
			undefined,
			undefined,
			"copy-retain",
			hasExistingSidecars ? "off" : "enabled",
		);
	} catch (err) {
		if (isEnoent(err)) throw new Error(`File not found: ${inputPath}`);
		throw err;
	}

	try {
		await writeSessionHtml(sm, undefined, outputPath, opts.themeName);
		return outputPath;
	} finally {
		await sm.close();
	}
}
