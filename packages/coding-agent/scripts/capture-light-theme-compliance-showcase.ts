import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	LIGHT_THEME_COMPLIANCE_ENTRIES,
	LIGHT_THEME_COMPLIANCE_EXPECTED_ENTRY_COUNT,
	LIGHT_THEME_COMPLIANCE_SCENE_IDS,
	LIGHT_THEME_COMPLIANCE_THEMES,
	LIGHT_THEME_COMPLIANCE_VIEWPORTS,
	type LightThemeComplianceEntry,
	renderLightThemeComplianceShowcase,
} from "../test/fixtures/tui/light-theme-compliance-showcase";
import {
	assertHtmlThemeIdentity,
	assertThemeEvidenceIdentity,
	type CaptureEnvironment,
	CELL_GEOMETRY,
	captureEnvironment,
	captureSourceFingerprint,
	cellGridToHtml,
	cellGridToSvg,
	type FontRecord,
	parseAnsiCellGrid,
	rasterizeSvg,
	sha256,
	stableJson,
} from "./lib/terminal-visual-evidence";

const CAPTURE_TOOL_VERSION = "gjc-light-theme-compliance-v1";
const CANONICAL_COMMAND =
	"bun packages/coding-agent/scripts/capture-light-theme-compliance-showcase.ts --output .gjc/qa/gjc-light-theme-compliance/current";
const EXPECTED_LEAF_COUNT = 820;

interface ArtifactFile {
	path: string;
	sha256: string;
	byte_length: number;
}

interface ManifestEntry {
	key: string;
	theme: string;
	scene_id: string;
	viewport: { id: string; columns: number; rows: number };
	render_mode: string;
	theme_sentinel_sha256: string;
	cell_grid_sha256: string;
	occupancy_sha256: string;
	display_list_sha256: string;
	decoded_rgba_sha256: string;
	files: ArtifactFile[];
}

function parseOutputPath(args: string[]): string {
	if (args.length !== 2 || args[0] !== "--output" || !args[1]) {
		throw new Error(`Usage: ${CANONICAL_COMMAND}`);
	}
	return path.resolve(args[1]);
}

async function writeArtifact(
	outputRoot: string,
	filePath: string,
	content: string | Uint8Array,
): Promise<ArtifactFile> {
	await Bun.write(filePath, content);
	const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
	return {
		path: path.relative(outputRoot, filePath).split(path.sep).join("/"),
		sha256: sha256(bytes),
		byte_length: bytes.byteLength,
	};
}

function entryDirectory(outputRoot: string, entry: LightThemeComplianceEntry): string {
	return path.join(outputRoot, entry.theme, entry.sceneId, entry.viewport.id, entry.renderMode);
}

async function captureEntry(
	outputRoot: string,
	entry: LightThemeComplianceEntry,
	environment: CaptureEnvironment,
	source: { source_revision: string; source_fingerprint: string },
): Promise<ManifestEntry> {
	const rendered = await renderLightThemeComplianceShowcase(entry);
	assertThemeEvidenceIdentity(rendered.themeIdentity, entry.theme);
	const grid = parseAnsiCellGrid(
		rendered.terminalAnsiText,
		entry.viewport.columns,
		entry.viewport.rows,
		rendered.themeIdentity.themeSentinelRoles.text!,
		rendered.themeIdentity.pageBackground,
	);
	if (grid.plainText !== rendered.terminalText) throw new Error(`Plain/cell-grid mismatch for ${entry.key}`);
	const html = cellGridToHtml(
		grid,
		entry.theme,
		rendered.themeIdentity.themeSentinelSha256,
		rendered.themeIdentity.pageBackground,
	);
	const display = cellGridToSvg(
		grid,
		entry.theme,
		rendered.themeIdentity.themeSentinelSha256,
		rendered.themeIdentity.themeSentinelRoles,
		rendered.themeIdentity.pageBackground,
	);
	const fonts = environment.fonts;
	const selectedScripts = new Set<FontRecord["coveredScript"]>(["latin-terminal"]);
	if (/[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/u.test(grid.plainText)) selectedScripts.add("korean");
	if (/[\u3040-\u30ff]/u.test(grid.plainText)) selectedScripts.add("japanese");
	if (/[\u3400-\u9fff]/u.test(grid.plainText)) selectedScripts.add("simplified-chinese");
	const selectedFonts = fonts.filter(font => selectedScripts.has(font.coveredScript));
	const png = rasterizeSvg(
		display.svg,
		selectedFonts.map(font => font.path),
		display.samples,
	);
	const expectedWidth = entry.viewport.columns * CELL_GEOMETRY.cellWidthPx + CELL_GEOMETRY.horizontalPaddingPx * 2;
	const expectedHeight = entry.viewport.rows * CELL_GEOMETRY.cellHeightPx + CELL_GEOMETRY.verticalPaddingPx * 2;
	if (png.width !== expectedWidth || png.height !== expectedHeight) {
		throw new Error(`PNG dimensions mismatch for ${entry.key}: ${png.width}x${png.height}`);
	}
	assertHtmlThemeIdentity(html, entry.theme, rendered.themeIdentity.themeSentinelSha256);
	const metadata = stableJson({
		schema_version: 1,
		entry_key: entry.key,
		theme: {
			requested_theme: rendered.themeIdentity.requestedTheme,
			resolved_theme: rendered.themeIdentity.resolvedTheme,
			manifest_key_theme: rendered.themeIdentity.keyTheme,
			theme_sentinel_roles: rendered.themeIdentity.themeSentinelRoles,
			theme_sentinel_sha256: rendered.themeIdentity.themeSentinelSha256,
			page_background: rendered.themeIdentity.pageBackground,
		},
		viewport: entry.viewport,
		scene_id: entry.sceneId,
		render_mode: entry.renderMode,
		cell_grid: {
			sha256: grid.sha256,
			occupancy_sha256: grid.occupancySha256,
			columns: grid.columns,
			rows: grid.rows,
		},
		display_list: {
			sha256: display.displayListSha256,
			theme_sentinel_sha256: rendered.themeIdentity.themeSentinelSha256,
		},
		png: {
			format: "png",
			width: png.width,
			height: png.height,
			device_pixel_ratio: CELL_GEOMETRY.devicePixelRatio,
			byte_sha256: png.byteSha256,
			decoded_rgba_sha256: png.decodedRgbaSha256,
			non_uniform: png.nonUniform,
			sentinel_samples: png.sentinelSamples,
		},
		window: rendered.window,
		provenance: rendered.provenance,
		environment_id: environment.environment_id,
		source_revision: source.source_revision,
		source_fingerprint: source.source_fingerprint,
		terminal_evidence: {
			capture_timestamp: rendered.provenance.fixedClockTimestamp,
			actual_capture_receipt: "run-receipt.json",
			tool_version: CAPTURE_TOOL_VERSION,
			command_or_replay_source: CANONICAL_COMMAND,
			terminal_size: entry.viewport,
			font_rendering_assumptions: "capture-environment.json#fonts,cell_geometry,color_profile",
			wrapping_policy: "production renderer output; grapheme cells use Intl.Segmenter and Bun.stringWidth",
			truncation_policy: "production width truncation; capture rejects vertical overflow",
			capture_mode: rendered.provenance.captureMode,
		},
	});
	const directory = entryDirectory(outputRoot, entry);
	await fs.mkdir(directory, { recursive: true });
	const files = await Promise.all([
		writeArtifact(outputRoot, path.join(directory, "terminal.txt"), grid.plainText),
		writeArtifact(outputRoot, path.join(directory, "terminal-ansi.txt"), rendered.terminalAnsiText),
		writeArtifact(outputRoot, path.join(directory, "terminal.html"), html),
		writeArtifact(outputRoot, path.join(directory, "metadata.json"), metadata),
		writeArtifact(outputRoot, path.join(directory, "terminal.png"), png.bytes),
	]);
	return {
		key: entry.key,
		theme: entry.theme,
		scene_id: entry.sceneId,
		viewport: entry.viewport,
		render_mode: entry.renderMode,
		theme_sentinel_sha256: rendered.themeIdentity.themeSentinelSha256,
		cell_grid_sha256: grid.sha256,
		occupancy_sha256: grid.occupancySha256,
		display_list_sha256: display.displayListSha256,
		decoded_rgba_sha256: png.decodedRgbaSha256,
		files,
	};
}

async function main(): Promise<void> {
	Bun.env.TZ = "UTC";
	Bun.env.LANG = "en_US.UTF-8";
	Bun.env.LC_ALL = "en_US.UTF-8";
	const startedAt = Date.now();
	const outputRoot = parseOutputPath(process.argv.slice(2));
	const repoRoot = path.resolve(import.meta.dir, "../../..");
	await fs.rm(outputRoot, { recursive: true, force: true });
	await fs.mkdir(outputRoot, { recursive: true });
	const environment = await captureEnvironment(repoRoot);
	const source = await captureSourceFingerprint(repoRoot);
	const entries: ManifestEntry[] = [];
	for (const entry of LIGHT_THEME_COMPLIANCE_ENTRIES) {
		entries.push(await captureEntry(outputRoot, entry, environment, source));
	}
	const leafCount = entries.reduce((total, entry) => total + entry.files.length, 0);
	if (entries.length !== LIGHT_THEME_COMPLIANCE_EXPECTED_ENTRY_COUNT || leafCount !== EXPECTED_LEAF_COUNT) {
		throw new Error(`Capture count mismatch: entries=${entries.length}, leaves=${leafCount}`);
	}
	const keys = entries.map(entry => entry.key);
	if (new Set(keys).size !== keys.length) throw new Error("Capture contains duplicate entry keys");
	const manifest = stableJson({
		schema_version: 1,
		capture_tool: CAPTURE_TOOL_VERSION,
		command: CANONICAL_COMMAND,
		source_revision: source.source_revision,
		source_fingerprint: source.source_fingerprint,
		source_files: source.source_files,
		environment_id: environment.environment_id,
		expected_entry_count: LIGHT_THEME_COMPLIANCE_EXPECTED_ENTRY_COUNT,
		entry_count: entries.length,
		expected_leaf_count: EXPECTED_LEAF_COUNT,
		leaf_count: leafCount,
		matrix: {
			themes: LIGHT_THEME_COMPLIANCE_THEMES,
			scene_ids: LIGHT_THEME_COMPLIANCE_SCENE_IDS,
			canonical_viewports: LIGHT_THEME_COMPLIANCE_VIEWPORTS,
			baseline_count: 144,
			ascii_no_color_count: 12,
			cjk_48x36_count: 8,
		},
		control_files: ["capture-environment.json", "review-input.json", "run-receipt.json"],
		entries,
	});
	const manifestSha256 = sha256(manifest);
	const reviewInput = stableJson({
		schema_version: 1,
		manifest_path: "manifest.json",
		manifest_sha256: manifestSha256,
		source_revision: source.source_revision,
		environment_id: environment.environment_id,
		expected_entry_count: 164,
		expected_leaf_count: 820,
		reviewed_entry_keys: keys,
		reviewer_output_file: "independent-review.json",
		requirements: [
			"Recompute every leaf hash and byte length before visual inspection.",
			"Inspect all 164 entries without sampling, including every CJK, overflow, and no-color key.",
			"Reject any requested/resolved/key/sentinel mismatch, bad semantic wrap, hidden tail, or unresolved finding.",
		],
	});
	await Bun.write(path.join(outputRoot, "manifest.json"), manifest);
	await Bun.write(path.join(outputRoot, "capture-environment.json"), stableJson(environment));
	await Bun.write(path.join(outputRoot, "review-input.json"), reviewInput);
	await Bun.write(
		path.join(outputRoot, "run-receipt.json"),
		stableJson({
			schema_version: 1,
			captured_at: new Date().toISOString(),
			elapsed_ms: Date.now() - startedAt,
			output_path: outputRoot,
			manifest_sha256: manifestSha256,
			source_revision: source.source_revision,
			environment_id: environment.environment_id,
			entry_count: entries.length,
			leaf_count: leafCount,
			cleanup_status: "complete",
		}),
	);
	process.stdout.write(
		`Captured ${entries.length} GJC light-theme TUI entries (${leafCount} leaves) to ${outputRoot}\nmanifest.json sha256: ${manifestSha256}\nenvironment_id: ${String(environment.environment_id)}\n`,
	);
}

await main();
