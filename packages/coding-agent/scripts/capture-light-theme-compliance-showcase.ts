import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	LIGHT_THEME_COMPLIANCE_ENTRIES,
	LIGHT_THEME_COMPLIANCE_EXPECTED_ENTRY_COUNT,
	LIGHT_THEME_COMPLIANCE_EXPECTED_LEAF_COUNT,
	LIGHT_THEME_COMPLIANCE_SCENE_IDS,
	LIGHT_THEME_COMPLIANCE_THEMES,
	LIGHT_THEME_COMPLIANCE_VIEWPORTS,
	type LightThemeComplianceEntry,
	renderLightThemeComplianceShowcase,
} from "../test/fixtures/tui/light-theme-compliance-showcase";
import { LIGHT_THEME_CONSUMER_ATLAS_VIEWPORTS } from "../test/fixtures/tui/light-theme-consumer-atlas";
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
	LIGHT_THEME_EVIDENCE_CANONICAL_COMMAND,
	LIGHT_THEME_EVIDENCE_CAPTURE_TOOL_VERSION,
	LIGHT_THEME_EVIDENCE_REVIEW_REQUIREMENTS,
	parseAnsiCellGrid,
	rasterizeSvg,
	sha256,
	stableJson,
} from "./lib/terminal-visual-evidence";

const EXPECTED_LEAF_COUNT = LIGHT_THEME_COMPLIANCE_EXPECTED_LEAF_COUNT;
const QA_RELATIVE_ROOT = path.join(".gjc", "qa");
const AUTHOR_IDENTITY_PATTERN = /^[a-z][a-z0-9-]*:[^\s,]+$/;

interface AuthorIdentities {
	implementation_author_ids: string[];
	capture_author_ids: string[];
}

function readAuthorIdentityList(variableName: string): string[] {
	const raw = Bun.env[variableName];
	const identities = raw
		?.split(",")
		.map(identity => identity.trim())
		.filter(Boolean);
	if (
		!identities ||
		identities.length === 0 ||
		identities.some(identity => !AUTHOR_IDENTITY_PATTERN.test(identity)) ||
		new Set(identities).size !== identities.length
	) {
		throw new Error(
			`${variableName} must contain one or more unique comma-separated canonical identities (for example, github:octocat)`,
		);
	}
	return identities.sort((left, right) => left.localeCompare(right));
}

function readAuthorIdentities(): AuthorIdentities {
	return {
		implementation_author_ids: readAuthorIdentityList("GJC_LIGHT_THEME_IMPLEMENTATION_AUTHOR_IDS"),
		capture_author_ids: readAuthorIdentityList("GJC_LIGHT_THEME_CAPTURE_AUTHOR_IDS"),
	};
}

function isEnoent(error: unknown): boolean {
	return Boolean(
		error && typeof error === "object" && "code" in error && (error as { code: unknown }).code === "ENOENT",
	);
}

function samePath(left: string, right: string): boolean {
	return path.resolve(left) === path.resolve(right);
}

function isStrictDescendant(root: string, target: string): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(target));
	return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function hasLexicalDotDot(candidate: string): boolean {
	return candidate.split(/[\\/]/).includes("..");
}

function usageError(): Error {
	return new Error(`Usage: ${LIGHT_THEME_EVIDENCE_CANONICAL_COMMAND}`);
}

function rejectionError(reason: string, candidate: string): Error {
	return new Error(`Refusing capture output path (${reason}): ${candidate}`);
}

/**
 * Resolve and preflight the capture `--output` path without mutating the filesystem.
 * Returns a path that is a strict non-symlinked descendant of `<repo>/.gjc/qa`.
 */
export async function resolveCaptureOutputPath(
	args: string[],
	repoRoot: string,
	homeDir: string = os.homedir(),
): Promise<string> {
	if (args.length !== 2 || args[0] !== "--output" || !args[1]) throw usageError();

	const requested = args[1];
	if (hasLexicalDotDot(requested)) {
		throw rejectionError("lexical .. alias", requested);
	}

	const resolvedRepoRoot = path.resolve(repoRoot);
	const resolvedHome = path.resolve(homeDir);
	const qaRoot = path.join(resolvedRepoRoot, QA_RELATIVE_ROOT);
	const gitDir = path.join(resolvedRepoRoot, ".git");
	const filesystemRoot = path.parse(resolvedRepoRoot).root;

	const outputPath = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(resolvedRepoRoot, requested);

	if (samePath(outputPath, filesystemRoot)) {
		throw rejectionError("filesystem root", outputPath);
	}
	if (samePath(outputPath, resolvedRepoRoot)) {
		throw rejectionError("repository root", outputPath);
	}
	if (samePath(outputPath, resolvedHome)) {
		throw rejectionError("home directory", outputPath);
	}
	if (samePath(outputPath, gitDir) || isStrictDescendant(gitDir, outputPath)) {
		throw rejectionError(".git directory", outputPath);
	}
	if (samePath(outputPath, qaRoot)) {
		throw rejectionError("QA root", outputPath);
	}
	if (!isStrictDescendant(qaRoot, outputPath)) {
		throw rejectionError("outside dedicated .gjc/qa root", outputPath);
	}
	if (hasLexicalDotDot(path.relative(qaRoot, outputPath))) {
		throw rejectionError("lexical .. alias", outputPath);
	}

	// No-follow walk from the repository root so host aliases like /tmp -> /private/tmp
	// do not block legitimate temp fixtures while still rejecting repo-local escapes.
	const relativeFromRepo = path.relative(resolvedRepoRoot, outputPath);
	let cursor = resolvedRepoRoot;
	for (const segment of relativeFromRepo.split(path.sep)) {
		cursor = path.join(cursor, segment);
		let stats: Stats;
		try {
			stats = await fs.lstat(cursor);
		} catch (error) {
			if (isEnoent(error)) break;
			throw error;
		}
		if (stats.isSymbolicLink()) {
			throw rejectionError("symlink component", cursor);
		}
	}

	let realRepoRoot = resolvedRepoRoot;
	try {
		realRepoRoot = await fs.realpath(resolvedRepoRoot);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}

	let realHome = resolvedHome;
	try {
		realHome = await fs.realpath(resolvedHome);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}

	const realQaRoot = path.join(realRepoRoot, QA_RELATIVE_ROOT);
	const realGitDir = path.join(realRepoRoot, ".git");

	let existingAncestor = outputPath;
	const missingSuffix: string[] = [];
	for (;;) {
		try {
			const stats = await fs.lstat(existingAncestor);
			if (stats.isSymbolicLink()) {
				throw rejectionError("symlink component", existingAncestor);
			}
			break;
		} catch (error) {
			if (!isEnoent(error)) throw error;
			const parent = path.dirname(existingAncestor);
			if (samePath(parent, existingAncestor)) break;
			missingSuffix.unshift(path.basename(existingAncestor));
			existingAncestor = parent;
		}
	}

	try {
		const realAncestor = await fs.realpath(existingAncestor);
		const realOutputPath = missingSuffix.length === 0 ? realAncestor : path.resolve(realAncestor, ...missingSuffix);

		if (samePath(realOutputPath, path.parse(realOutputPath).root)) {
			throw rejectionError("filesystem root alias", realOutputPath);
		}
		if (samePath(realOutputPath, realRepoRoot)) {
			throw rejectionError("repository root alias", realOutputPath);
		}
		if (samePath(realOutputPath, realHome)) {
			throw rejectionError("home directory alias", realOutputPath);
		}
		if (samePath(realOutputPath, realGitDir) || isStrictDescendant(realGitDir, realOutputPath)) {
			throw rejectionError(".git directory alias", realOutputPath);
		}
		if (samePath(realOutputPath, realQaRoot)) {
			throw rejectionError("QA root alias", realOutputPath);
		}
		if (!isStrictDescendant(realQaRoot, realOutputPath)) {
			throw rejectionError("canonical path escapes .gjc/qa", realOutputPath);
		}
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("Refusing capture output path")) throw error;
		if (!isEnoent(error)) throw error;
	}

	return outputPath;
}

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
			tool_version: LIGHT_THEME_EVIDENCE_CAPTURE_TOOL_VERSION,
			command_or_replay_source: LIGHT_THEME_EVIDENCE_CANONICAL_COMMAND,
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
	const repoRoot = path.resolve(import.meta.dir, "../../..");
	const outputRoot = await resolveCaptureOutputPath(process.argv.slice(2), repoRoot);
	const receiptOutputPath = path.relative(repoRoot, outputRoot).split(path.sep).join("/");
	const authorIdentities = readAuthorIdentities();
	const environment = await captureEnvironment(repoRoot);
	const source = await captureSourceFingerprint(repoRoot);
	await fs.rm(outputRoot, { recursive: true, force: true });
	await fs.mkdir(outputRoot, { recursive: true });
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
		schema_version: 2,
		capture_tool: LIGHT_THEME_EVIDENCE_CAPTURE_TOOL_VERSION,
		command: LIGHT_THEME_EVIDENCE_CANONICAL_COMMAND,
		source_revision: source.source_revision,
		source_fingerprint: source.source_fingerprint,
		source_files: source.source_files,
		environment_id: environment.environment_id,
		author_identities: authorIdentities,
		expected_entry_count: LIGHT_THEME_COMPLIANCE_EXPECTED_ENTRY_COUNT,
		entry_count: entries.length,
		expected_leaf_count: EXPECTED_LEAF_COUNT,
		leaf_count: leafCount,
		matrix: {
			themes: LIGHT_THEME_COMPLIANCE_THEMES,
			scene_ids: LIGHT_THEME_COMPLIANCE_SCENE_IDS,
			canonical_viewports: LIGHT_THEME_COMPLIANCE_VIEWPORTS,
			consumer_atlas_viewports: LIGHT_THEME_CONSUMER_ATLAS_VIEWPORTS,
			baseline_count: 144,
			ascii_no_color_count: 12,
			cjk_48x36_truecolor_count: 8,
			consumer_atlas_truecolor_count: 6,
			ansi_256_color_count: 10,
		},
		control_files: ["capture-environment.json", "review-input.json", "run-receipt.json"],
		entries,
	});
	const manifestSha256 = sha256(manifest);
	const reviewInput = stableJson({
		schema_version: 2,
		manifest_path: "manifest.json",
		manifest_sha256: manifestSha256,
		source_revision: source.source_revision,
		environment_id: environment.environment_id,
		author_identities: authorIdentities,
		expected_entry_count: LIGHT_THEME_COMPLIANCE_EXPECTED_ENTRY_COUNT,
		expected_leaf_count: EXPECTED_LEAF_COUNT,
		reviewed_entry_keys: keys,
		reviewer_output_file: "independent-review.json",
		requirements: LIGHT_THEME_EVIDENCE_REVIEW_REQUIREMENTS,
	});
	await Bun.write(path.join(outputRoot, "manifest.json"), manifest);
	await Bun.write(path.join(outputRoot, "capture-environment.json"), stableJson(environment));
	await Bun.write(path.join(outputRoot, "review-input.json"), reviewInput);
	await Bun.write(
		path.join(outputRoot, "run-receipt.json"),
		stableJson({
			schema_version: 2,
			captured_at: new Date().toISOString(),
			elapsed_ms: Date.now() - startedAt,
			output_path: receiptOutputPath,
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

if (import.meta.main) {
	await main();
}
