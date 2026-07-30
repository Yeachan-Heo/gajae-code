import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	assertHtmlThemeIdentity,
	assertThemeEvidenceIdentity,
	CANONICAL_DARWIN_FONTS,
	CELL_GEOMETRY,
	captureSourceFingerprint,
	cellGridToHtml,
	cellGridToSvg,
	decodePngRgba,
	fingerprintEvidenceSourceFiles,
	LIGHT_THEME_EVIDENCE_CANONICAL_COMMAND,
	LIGHT_THEME_EVIDENCE_CANONICAL_OUTPUT,
	LIGHT_THEME_EVIDENCE_CAPTURE_TOOL_VERSION,
	LIGHT_THEME_EVIDENCE_REVIEW_REQUIREMENTS,
	parseAnsiCellGrid,
	pngPixelHex,
	rasterizeSvg,
	type SourceFingerprint,
	sha256,
	stableJson,
	TERMINAL_EVIDENCE_VERSION,
} from "../scripts/lib/terminal-visual-evidence";
import {
	LIGHT_THEME_COMPLIANCE_ANSI_256_SCENES,
	LIGHT_THEME_COMPLIANCE_ASCII_NO_COLOR_SCENES,
	LIGHT_THEME_COMPLIANCE_CJK_SCENES,
	LIGHT_THEME_COMPLIANCE_ENTRIES,
	LIGHT_THEME_COMPLIANCE_EXPECTED_ENTRY_COUNT,
	LIGHT_THEME_COMPLIANCE_EXPECTED_LEAF_COUNT,
	LIGHT_THEME_COMPLIANCE_SCENE_IDS,
	LIGHT_THEME_COMPLIANCE_THEMES,
	LIGHT_THEME_COMPLIANCE_VIEWPORTS,
	type LightThemeComplianceEntry,
	renderLightThemeComplianceShowcase,
} from "./fixtures/tui/light-theme-compliance-showcase";
import { LIGHT_THEME_CONSUMER_ATLAS_VIEWPORTS } from "./fixtures/tui/light-theme-consumer-atlas";

interface ArtifactFile {
	path: string;
	sha256: string;
	byte_length: number;
}

interface ArtifactEntry {
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

interface ArtifactSourceFile {
	path: string;
	sha256: string;
	byte_length: number;
}

interface ArtifactManifest {
	schema_version: 2;
	capture_tool: string;
	command: string;
	source_revision: string;
	source_fingerprint: string;
	source_files: ArtifactSourceFile[];
	environment_id: string;
	author_identities: {
		implementation_author_ids: string[];
		capture_author_ids: string[];
	};
	expected_entry_count: number;
	entry_count: number;
	expected_leaf_count: number;
	leaf_count: number;
	matrix: Record<string, unknown>;
	control_files: string[];
	entries: ArtifactEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
		throw new Error(`${label} must be a string array`);
	}
	return value;
}

function isSha256(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function authorIdentityArray(value: unknown, label: string): string[] {
	const identities = stringArray(value, label);
	if (
		identities.length === 0 ||
		identities.some(identity => !/^[a-z][a-z0-9-]*:[^\s,]+$/.test(identity)) ||
		new Set(identities).size !== identities.length
	) {
		throw new Error(`${label} must contain unique canonical identities`);
	}
	return identities;
}

function readManifest(value: unknown): ArtifactManifest {
	if (!isRecord(value) || value.schema_version !== 2 || !Array.isArray(value.entries)) {
		throw new Error("Invalid light-theme manifest");
	}
	const allowedManifestFields = new Set([
		"schema_version",
		"capture_tool",
		"command",
		"source_revision",
		"source_fingerprint",
		"source_files",
		"environment_id",
		"author_identities",
		"expected_entry_count",
		"entry_count",
		"expected_leaf_count",
		"leaf_count",
		"matrix",
		"control_files",
		"entries",
	]);
	for (const key of Object.keys(value))
		if (!allowedManifestFields.has(key)) throw new Error(`Unknown manifest field: ${key}`);
	if (
		typeof value.capture_tool !== "string" ||
		!value.capture_tool ||
		typeof value.command !== "string" ||
		!value.command ||
		typeof value.source_revision !== "string" ||
		!value.source_revision ||
		!isSha256(value.source_fingerprint) ||
		!isSha256(value.environment_id)
	) {
		throw new Error("Manifest authority identity is incomplete");
	}
	const entries: ArtifactEntry[] = value.entries.map((rawEntry, index) => {
		if (!isRecord(rawEntry) || !Array.isArray(rawEntry.files)) throw new Error(`Invalid manifest entry ${index}`);
		const allowedEntryFields = new Set([
			"key",
			"theme",
			"scene_id",
			"viewport",
			"render_mode",
			"theme_sentinel_sha256",
			"cell_grid_sha256",
			"occupancy_sha256",
			"display_list_sha256",
			"decoded_rgba_sha256",
			"files",
		]);
		for (const key of Object.keys(rawEntry)) {
			if (!allowedEntryFields.has(key)) throw new Error(`Unknown manifest entry field ${index}.${key}`);
		}
		if (!isRecord(rawEntry.viewport)) throw new Error(`Invalid manifest entry viewport ${index}`);
		exactObjectKeys(rawEntry.viewport, ["id", "columns", "rows"], `Manifest entry ${index} viewport`);
		if (
			typeof rawEntry.key !== "string" ||
			typeof rawEntry.theme !== "string" ||
			typeof rawEntry.scene_id !== "string" ||
			typeof rawEntry.render_mode !== "string" ||
			!isSha256(rawEntry.theme_sentinel_sha256) ||
			!isSha256(rawEntry.cell_grid_sha256) ||
			!isSha256(rawEntry.occupancy_sha256) ||
			!isSha256(rawEntry.display_list_sha256) ||
			!isSha256(rawEntry.decoded_rgba_sha256) ||
			typeof rawEntry.viewport.id !== "string" ||
			!Number.isSafeInteger(rawEntry.viewport.columns) ||
			!Number.isSafeInteger(rawEntry.viewport.rows) ||
			Number(rawEntry.viewport.columns) <= 0 ||
			Number(rawEntry.viewport.rows) <= 0
		) {
			throw new Error(`Invalid manifest entry authority ${index}`);
		}
		const files: ArtifactFile[] = rawEntry.files.map(rawFile => {
			if (!isRecord(rawFile)) throw new Error(`Invalid artifact file in entry ${index}`);
			exactObjectKeys(rawFile, ["path", "sha256", "byte_length"], `Manifest entry ${index} file`);
			if (
				typeof rawFile.path !== "string" ||
				path.posix.normalize(rawFile.path) !== rawFile.path ||
				path.posix.isAbsolute(rawFile.path) ||
				rawFile.path.startsWith("../") ||
				!isSha256(rawFile.sha256) ||
				!Number.isSafeInteger(rawFile.byte_length) ||
				Number(rawFile.byte_length) < 0
			) {
				throw new Error(`Invalid artifact file in entry ${index}`);
			}
			return { path: rawFile.path, sha256: rawFile.sha256, byte_length: rawFile.byte_length as number };
		});
		return {
			key: rawEntry.key,
			theme: rawEntry.theme,
			scene_id: rawEntry.scene_id,
			viewport: {
				id: rawEntry.viewport.id,
				columns: rawEntry.viewport.columns as number,
				rows: rawEntry.viewport.rows as number,
			},
			render_mode: rawEntry.render_mode,
			theme_sentinel_sha256: rawEntry.theme_sentinel_sha256,
			cell_grid_sha256: rawEntry.cell_grid_sha256,
			occupancy_sha256: rawEntry.occupancy_sha256,
			display_list_sha256: rawEntry.display_list_sha256,
			decoded_rgba_sha256: rawEntry.decoded_rgba_sha256,
			files,
		};
	});
	if (!Array.isArray(value.source_files)) throw new Error("Invalid manifest source_files");
	const source_files: ArtifactSourceFile[] = value.source_files.map((rawFile, index) => {
		if (!isRecord(rawFile)) throw new Error(`Invalid manifest source file ${index}`);
		exactObjectKeys(rawFile, ["path", "sha256", "byte_length"], `Manifest source file ${index}`);
		if (
			typeof rawFile.path !== "string" ||
			path.posix.normalize(rawFile.path) !== rawFile.path ||
			path.posix.isAbsolute(rawFile.path) ||
			rawFile.path.startsWith("../") ||
			!isSha256(rawFile.sha256) ||
			!Number.isSafeInteger(rawFile.byte_length) ||
			Number(rawFile.byte_length) < 0
		) {
			throw new Error(`Invalid manifest source file ${index}`);
		}
		return { path: rawFile.path, sha256: rawFile.sha256, byte_length: rawFile.byte_length as number };
	});
	if (!isRecord(value.author_identities)) throw new Error("Manifest author identities are missing");
	exactObjectKeys(
		value.author_identities,
		["implementation_author_ids", "capture_author_ids"],
		"Manifest author identities",
	);
	const author_identities = {
		implementation_author_ids: authorIdentityArray(
			value.author_identities.implementation_author_ids,
			"manifest implementation authors",
		),
		capture_author_ids: authorIdentityArray(value.author_identities.capture_author_ids, "manifest capture authors"),
	};
	for (const key of ["expected_entry_count", "entry_count", "expected_leaf_count", "leaf_count"] as const) {
		if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0) throw new Error(`Invalid manifest ${key}`);
	}
	if (!isRecord(value.matrix)) throw new Error("Invalid manifest matrix");
	const control_files = stringArray(value.control_files, "manifest control files");
	return {
		schema_version: 2,
		capture_tool: value.capture_tool,
		command: value.command,
		source_revision: value.source_revision,
		source_fingerprint: value.source_fingerprint,
		source_files,
		environment_id: value.environment_id,
		author_identities,
		expected_entry_count: value.expected_entry_count as number,
		entry_count: value.entry_count as number,
		expected_leaf_count: value.expected_leaf_count as number,
		leaf_count: value.leaf_count as number,
		matrix: value.matrix,
		control_files,
		entries,
	};
}

function expectedLanguageKeys(sceneId: string): string[] {
	return LIGHT_THEME_COMPLIANCE_ENTRIES.filter(
		entry => entry.sceneId === sceneId && entry.renderMode !== "ascii-no-color",
	)
		.map(entry => entry.key)
		.sort();
}

function expectedOverflowKeys(sceneId?: string): string[] {
	return LIGHT_THEME_COMPLIANCE_ENTRIES.filter(
		entry =>
			entry.renderMode === "unicode-color" &&
			entry.viewport.id !== "48x36" &&
			(sceneId ? entry.sceneId === sceneId : entry.sceneId.startsWith("overflow-")),
	)
		.map(entry => entry.key)
		.sort();
}

function expectedNoColorKeys(): string[] {
	return LIGHT_THEME_COMPLIANCE_ENTRIES.filter(entry => entry.renderMode === "ascii-no-color")
		.map(entry => entry.key)
		.sort();
}

function expectedConsumerAtlasKeys(): string[] {
	return LIGHT_THEME_COMPLIANCE_ENTRIES.filter(entry => entry.sceneId === "consumer-atlas")
		.map(entry => entry.key)
		.sort();
}

function expectedAnsi256Keys(): string[] {
	return LIGHT_THEME_COMPLIANCE_ENTRIES.filter(entry => entry.renderMode === "unicode-256-color")
		.map(entry => entry.key)
		.sort();
}

const EVIDENCE_ENTRY_FILENAMES = [
	"metadata.json",
	"terminal-ansi.txt",
	"terminal.html",
	"terminal.png",
	"terminal.txt",
] as const;

function exactStringSet(actual: readonly string[], expected: readonly string[], label: string): void {
	const actualSorted = [...actual].sort();
	const expectedSorted = [...expected].sort();
	if (
		actualSorted.length !== expectedSorted.length ||
		new Set(actualSorted).size !== actualSorted.length ||
		actualSorted.join("\n") !== expectedSorted.join("\n")
	) {
		throw new Error(`${label} does not match the exact canonical set`);
	}
}

function exactObjectKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
	exactStringSet(Object.keys(value), expected, `${label} fields`);
}

function validateManifestContract(manifest: ArtifactManifest): void {
	if (
		manifest.capture_tool !== LIGHT_THEME_EVIDENCE_CAPTURE_TOOL_VERSION ||
		manifest.command !== LIGHT_THEME_EVIDENCE_CANONICAL_COMMAND ||
		manifest.expected_entry_count !== LIGHT_THEME_COMPLIANCE_EXPECTED_ENTRY_COUNT ||
		manifest.entry_count !== LIGHT_THEME_COMPLIANCE_EXPECTED_ENTRY_COUNT ||
		manifest.expected_leaf_count !== LIGHT_THEME_COMPLIANCE_EXPECTED_LEAF_COUNT ||
		manifest.leaf_count !== LIGHT_THEME_COMPLIANCE_EXPECTED_LEAF_COUNT ||
		manifest.entry_count !== manifest.entries.length ||
		manifest.leaf_count !== manifest.entries.reduce((total, entry) => total + entry.files.length, 0)
	) {
		throw new Error("Manifest authority or count contract mismatch");
	}
	const expectedByKey = new Map(LIGHT_THEME_COMPLIANCE_ENTRIES.map(entry => [entry.key, entry] as const));
	exactStringSet(
		manifest.entries.map(entry => entry.key),
		[...expectedByKey.keys()],
		"Manifest entry keys",
	);
	for (const entry of manifest.entries) {
		const expected = expectedByKey.get(entry.key);
		if (
			!expected ||
			entry.theme !== expected.theme ||
			entry.scene_id !== expected.sceneId ||
			entry.render_mode !== expected.renderMode ||
			entry.viewport.id !== expected.viewport.id ||
			entry.viewport.columns !== expected.viewport.columns ||
			entry.viewport.rows !== expected.viewport.rows
		) {
			throw new Error(`Manifest entry authority mismatch: ${entry.key}`);
		}
		for (const file of entry.files) {
			if (
				path.posix.normalize(file.path) !== file.path ||
				path.posix.isAbsolute(file.path) ||
				file.path.startsWith("../")
			) {
				throw new Error(`Manifest file path is unsafe: ${file.path}`);
			}
		}
		exactStringSet(
			entry.files.map(file => path.posix.basename(file.path)),
			EVIDENCE_ENTRY_FILENAMES,
			`Manifest files for ${entry.key}`,
		);
		for (const file of entry.files) {
			if (path.posix.dirname(file.path) !== entry.key) {
				throw new Error(`Manifest file escaped its canonical entry directory: ${file.path}`);
			}
		}
	}
	const sourcePaths = manifest.source_files.map(file => file.path);
	const sortedSourcePaths = [...sourcePaths].sort((left, right) => left.localeCompare(right));
	if (sourcePaths.join("\n") !== sortedSourcePaths.join("\n") || new Set(sourcePaths).size !== sourcePaths.length) {
		throw new Error("Manifest source authority must be sorted and unique");
	}
	if (sha256(stableJson(manifest.source_files)) !== manifest.source_fingerprint) {
		throw new Error("Manifest source fingerprint does not match its source file authority");
	}
	if (!new RegExp(`^[a-f0-9]{40}\\+worktree:${manifest.source_fingerprint}$`).test(manifest.source_revision)) {
		throw new Error("Manifest source revision is not bound to its source fingerprint");
	}
	exactStringSet(
		manifest.control_files,
		["capture-environment.json", "review-input.json", "run-receipt.json"],
		"Manifest control files",
	);
	const matrix = manifest.matrix;
	exactObjectKeys(
		matrix,
		[
			"themes",
			"scene_ids",
			"canonical_viewports",
			"consumer_atlas_viewports",
			"baseline_count",
			"ascii_no_color_count",
			"cjk_48x36_truecolor_count",
			"consumer_atlas_truecolor_count",
			"ansi_256_color_count",
		],
		"Manifest matrix",
	);
	if (
		stableJson(matrix.canonical_viewports) !== stableJson(LIGHT_THEME_COMPLIANCE_VIEWPORTS) ||
		stableJson(matrix.consumer_atlas_viewports) !== stableJson(LIGHT_THEME_CONSUMER_ATLAS_VIEWPORTS)
	) {
		throw new Error("Manifest viewport matrix mismatch");
	}
	exactStringSet(
		stringArray(matrix.themes, "manifest matrix themes"),
		LIGHT_THEME_COMPLIANCE_THEMES,
		"Manifest themes",
	);
	exactStringSet(
		stringArray(matrix.scene_ids, "manifest matrix scenes"),
		LIGHT_THEME_COMPLIANCE_SCENE_IDS,
		"Manifest scenes",
	);
	for (const [key, expected] of [
		["baseline_count", 144],
		["ascii_no_color_count", 12],
		["cjk_48x36_truecolor_count", 8],
		["consumer_atlas_truecolor_count", 6],
		["ansi_256_color_count", 10],
	] as const) {
		if (matrix[key] !== expected) throw new Error(`Manifest matrix ${key} mismatch`);
	}
	const manifestKeys = new Set(manifest.entries.map(entry => entry.key));
	const requiredSubsets = [
		...LIGHT_THEME_COMPLIANCE_CJK_SCENES.map(sceneId => expectedLanguageKeys(sceneId)),
		expectedOverflowKeys(),
		expectedNoColorKeys(),
		expectedConsumerAtlasKeys(),
		expectedAnsi256Keys(),
	];
	for (const subset of requiredSubsets) {
		for (const key of subset)
			if (!manifestKeys.has(key)) throw new Error(`Manifest omits required review key: ${key}`);
	}
}
function validateCurrentSourceAuthority(manifest: ArtifactManifest, currentSource: SourceFingerprint): void {
	if (
		manifest.source_revision !== currentSource.source_revision ||
		manifest.source_fingerprint !== currentSource.source_fingerprint ||
		stableJson(manifest.source_files) !== stableJson(currentSource.source_files)
	) {
		throw new Error("Manifest source authority does not match the exact current source closure");
	}
}

function makeManifestFixture(): ArtifactManifest {
	const hash = "a".repeat(64);
	const source_files: ArtifactSourceFile[] = [
		{ path: "bun.lock", sha256: hash, byte_length: 1 },
		{ path: "renderer.ts", sha256: hash, byte_length: 1 },
	];
	const source_fingerprint = sha256(stableJson(source_files));
	return {
		schema_version: 2,
		capture_tool: LIGHT_THEME_EVIDENCE_CAPTURE_TOOL_VERSION,
		command: LIGHT_THEME_EVIDENCE_CANONICAL_COMMAND,
		source_revision: `${"b".repeat(40)}+worktree:${source_fingerprint}`,
		source_fingerprint,
		source_files,
		environment_id: hash,
		author_identities: {
			implementation_author_ids: ["github:implementation-author"],
			capture_author_ids: ["github:capture-author"],
		},
		expected_entry_count: LIGHT_THEME_COMPLIANCE_EXPECTED_ENTRY_COUNT,
		entry_count: LIGHT_THEME_COMPLIANCE_EXPECTED_ENTRY_COUNT,
		expected_leaf_count: LIGHT_THEME_COMPLIANCE_EXPECTED_LEAF_COUNT,
		leaf_count: LIGHT_THEME_COMPLIANCE_EXPECTED_LEAF_COUNT,
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
		entries: LIGHT_THEME_COMPLIANCE_ENTRIES.map(entry => ({
			key: entry.key,
			theme: entry.theme,
			scene_id: entry.sceneId,
			viewport: entry.viewport,
			render_mode: entry.renderMode,
			theme_sentinel_sha256: hash,
			cell_grid_sha256: hash,
			occupancy_sha256: hash,
			display_list_sha256: hash,
			decoded_rgba_sha256: hash,
			files: EVIDENCE_ENTRY_FILENAMES.map(filename => ({
				path: `${entry.key}/${filename}`,
				sha256: hash,
				byte_length: 1,
			})),
		})),
	};
}

function validateIndependentReview(
	value: unknown,
	manifest: ArtifactManifest,
	manifestSha256: string,
	capturedAt: string,
): void {
	validateManifestContract(manifest);
	if (!isRecord(value)) throw new Error("Independent review must be an object");
	const allowed = new Set([
		"schema_version",
		"decision",
		"reviewed_at",
		"reviewer",
		"independence",
		"manifest",
		"inspection",
		"findings",
		"blocker_count",
		"reviewer_attestation",
		"notes",
	]);
	for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Unknown review field: ${key}`);
	if (value.schema_version !== 2 || value.decision !== "pass") throw new Error("Review is not a schema-v2 pass");
	if (
		typeof value.reviewed_at !== "string" ||
		!value.reviewed_at.endsWith("Z") ||
		Number.isNaN(Date.parse(value.reviewed_at)) ||
		Date.parse(value.reviewed_at) < Date.parse(capturedAt) ||
		Date.parse(value.reviewed_at) > Date.now() + 5 * 60_000
	) {
		throw new Error("Review timestamp is invalid or predates capture");
	}
	if (
		!isRecord(value.reviewer) ||
		typeof value.reviewer.id !== "string" ||
		!/^[a-z][a-z0-9-]*:[^\s,]+$/.test(value.reviewer.id) ||
		typeof value.reviewer.role !== "string" ||
		!value.reviewer.role ||
		typeof value.reviewer.affiliation !== "string" ||
		!value.reviewer.affiliation
	) {
		throw new Error("Reviewer identity is incomplete");
	}
	if (!isRecord(value.independence)) throw new Error("Review independence is missing");
	const implementationAuthors = authorIdentityArray(
		value.independence.implementation_author_ids,
		"implementation authors",
	);
	const captureAuthors = authorIdentityArray(value.independence.capture_author_ids, "capture authors");
	exactStringSet(
		implementationAuthors,
		manifest.author_identities.implementation_author_ids,
		"Review implementation authors",
	);
	exactStringSet(captureAuthors, manifest.author_identities.capture_author_ids, "Review capture authors");
	if (
		value.independence.reviewer_authored_implementation !== false ||
		value.independence.reviewer_authored_capture !== false ||
		implementationAuthors.includes(value.reviewer.id) ||
		captureAuthors.includes(value.reviewer.id) ||
		typeof value.independence.basis !== "string" ||
		!value.independence.basis
	) {
		throw new Error("Review is not independent");
	}
	if (!isRecord(value.manifest)) throw new Error("Review manifest binding is missing");
	if (
		value.manifest.path !== "manifest.json" ||
		value.manifest.sha256 !== manifestSha256 ||
		!isSha256(manifestSha256)
	) {
		throw new Error("Review manifest path or SHA-256 mismatch");
	}
	for (const [key, expected] of [
		["source_revision", manifest.source_revision],
		["environment_id", manifest.environment_id],
		["expected_entry_count", manifest.expected_entry_count],
		["observed_entry_count", manifest.entry_count],
		["expected_leaf_count", manifest.expected_leaf_count],
		["observed_leaf_count", manifest.leaf_count],
	] as const) {
		if (value.manifest[key] !== expected) throw new Error(`Review manifest ${key} mismatch`);
	}
	if (!isRecord(value.inspection)) throw new Error("Review inspection is missing");
	const reviewedKeys = stringArray(value.inspection.reviewed_entry_keys, "reviewed keys").sort();
	const manifestKeys = manifest.entries.map(entry => entry.key).sort();
	if (
		reviewedKeys.length !== LIGHT_THEME_COMPLIANCE_EXPECTED_ENTRY_COUNT ||
		new Set(reviewedKeys).size !== LIGHT_THEME_COMPLIANCE_EXPECTED_ENTRY_COUNT ||
		reviewedKeys.join("\n") !== manifestKeys.join("\n")
	) {
		throw new Error(`Review did not inspect the exact ${LIGHT_THEME_COMPLIANCE_EXPECTED_ENTRY_COUNT}-key set`);
	}
	if (!isRecord(value.inspection.formats)) throw new Error("Review formats are missing");
	for (const key of ["plain", "ansi", "html", "metadata", "png", "integrity"]) {
		if (value.inspection.formats[key] !== "pass") throw new Error(`Review format ${key} failed`);
	}
	if (!isRecord(value.inspection.themes)) throw new Error("Review theme inspection is missing");
	if (
		Object.keys(value.inspection.themes).sort().join("\n") !== [...LIGHT_THEME_COMPLIANCE_THEMES].sort().join("\n")
	) {
		throw new Error("Review theme inspection keys mismatch");
	}
	for (const themeName of LIGHT_THEME_COMPLIANCE_THEMES) {
		const result = value.inspection.themes[themeName];
		if (
			!isRecord(result) ||
			result.reviewed_entry_count !==
				LIGHT_THEME_COMPLIANCE_EXPECTED_ENTRY_COUNT / LIGHT_THEME_COMPLIANCE_THEMES.length ||
			result.requested_resolved_sentinel !== "pass" ||
			result.contrast_and_cues !== "pass"
		) {
			throw new Error(`Review theme result failed for ${themeName}`);
		}
	}
	if (!isRecord(value.inspection.languages)) throw new Error("Review languages are missing");
	if (
		Object.keys(value.inspection.languages).sort().join("\n") !==
		["chinese", "japanese", "korean", "mixed-cjk-latin"].sort().join("\n")
	) {
		throw new Error("Review language inspection keys mismatch");
	}
	for (const [language, sceneId] of [
		["korean", "wrap-korean"],
		["japanese", "wrap-japanese"],
		["chinese", "wrap-chinese"],
		["mixed-cjk-latin", "wrap-mixed-cjk-latin"],
	] as const) {
		const result = value.inspection.languages[language];
		if (!isRecord(result)) throw new Error(`Missing language review: ${language}`);
		const keys = stringArray(result.reviewed_entry_keys, `${language} reviewed keys`).sort();
		if (
			keys.join("\n") !== expectedLanguageKeys(sceneId).join("\n") ||
			result.graphemes !== "pass" ||
			result.semantic_breaks !== "pass" ||
			typeof result.notes !== "string"
		) {
			throw new Error(`Language review failed: ${language}`);
		}
	}
	if (!isRecord(value.inspection.overflow)) throw new Error("Overflow review is missing");
	if (Object.keys(value.inspection.overflow).sort().join("\n") !== ["bottom", "middle", "top"].join("\n")) {
		throw new Error("Review overflow inspection keys mismatch");
	}
	for (const position of ["top", "middle", "bottom"] as const) {
		const result = value.inspection.overflow[position];
		if (!isRecord(result)) throw new Error(`Missing overflow review: ${position}`);
		const keys = stringArray(result.reviewed_entry_keys, `${position} overflow keys`).sort();
		if (
			keys.join("\n") !== expectedOverflowKeys(`overflow-${position}`).join("\n") ||
			result.boundary_status !== "pass" ||
			result.focus_visibility !== "pass"
		) {
			throw new Error(`Overflow review failed: ${position}`);
		}
	}
	const sticky = value.inspection.sticky_virtualized;
	if (!isRecord(sticky)) throw new Error("Sticky/window review is missing");
	const stickyKeys = stringArray(sticky.reviewed_entry_keys, "sticky/window keys").sort();
	if (
		stickyKeys.join("\n") !== expectedOverflowKeys().join("\n") ||
		sticky.production_import !== "packages/coding-agent/src/modes/components/notifications-settings-editor.ts" ||
		sticky.mechanism !== "maxVisible-windowed" ||
		sticky.sticky_rows_stable !== "pass" ||
		sticky.first_interior_final_boundaries !== "pass" ||
		sticky.metadata_agreement !== "pass"
	) {
		throw new Error("Sticky/window review failed");
	}
	const consumerAtlas = value.inspection.consumer_atlas;
	if (!isRecord(consumerAtlas)) throw new Error("Consumer-atlas review is missing");
	const consumerAtlasKeys = stringArray(consumerAtlas.reviewed_entry_keys, "consumer-atlas keys").sort();
	if (
		consumerAtlasKeys.join("\n") !== expectedConsumerAtlasKeys().join("\n") ||
		consumerAtlas.production_component_rendering !== "pass" ||
		consumerAtlas.named_consumer_coverage !== "pass" ||
		consumerAtlas.responsive_widths !== "pass"
	) {
		throw new Error("Consumer-atlas review failed");
	}
	const noColor = value.inspection.no_color_cues;
	if (!isRecord(noColor)) throw new Error("No-color review is missing");
	const noColorKeys = stringArray(noColor.reviewed_entry_keys, "no-color keys").sort();
	if (noColorKeys.join("\n") !== expectedNoColorKeys().join("\n") || noColor.status !== "pass") {
		throw new Error("No-color review failed");
	}
	const ansi256 = value.inspection.ansi_256_color;
	if (!isRecord(ansi256)) throw new Error("256-color review is missing");
	const ansi256Keys = stringArray(ansi256.reviewed_entry_keys, "256-color keys").sort();
	if (
		ansi256Keys.join("\n") !== expectedAnsi256Keys().join("\n") ||
		ansi256.downsampling !== "pass" ||
		ansi256.contrast !== "pass" ||
		ansi256.non_color_cues !== "pass"
	) {
		throw new Error("256-color review failed");
	}
	if (!Array.isArray(value.findings)) throw new Error("Review findings must be an array");
	const severities = new Set(["blocker", "high", "medium", "low", "note"]);
	for (const [index, finding] of value.findings.entries()) {
		if (
			!isRecord(finding) ||
			typeof finding.id !== "string" ||
			!finding.id ||
			!severities.has(String(finding.severity)) ||
			typeof finding.description !== "string" ||
			!finding.description ||
			finding.disposition !== "resolved"
		) {
			throw new Error(`Invalid or unresolved review finding ${index}`);
		}
		const entryKeys = stringArray(finding.entry_keys, `finding ${index} entry keys`);
		if (entryKeys.some(key => !manifestKeys.includes(key))) {
			throw new Error(`Review finding ${index} references an unknown entry`);
		}
	}
	if (
		value.blocker_count !== 0 ||
		typeof value.reviewer_attestation !== "string" ||
		!value.reviewer_attestation ||
		(value.notes !== undefined && typeof value.notes !== "string")
	) {
		throw new Error("Review cannot pass with blockers, invalid notes, or no attestation");
	}
}

function validateCaptureEnvironment(value: unknown, manifest: ArtifactManifest): void {
	if (!isRecord(value)) throw new Error("Capture environment must be an object");
	const allowed = new Set([
		"schema_version",
		"os",
		"architecture",
		"bun_version",
		"lockfile_sha256",
		"resvg",
		"evidence_helper_version",
		"ansi_parser_version",
		"cell_width_implementation",
		"svg_serializer_version",
		"locale",
		"time_zone",
		"fonts",
		"cell_geometry",
		"color_profile",
		"environment_id",
	]);
	for (const key of Object.keys(value))
		if (!allowed.has(key)) throw new Error(`Unknown capture environment field: ${key}`);
	if (
		value.schema_version !== 1 ||
		value.environment_id !== manifest.environment_id ||
		!isSha256(value.environment_id)
	) {
		throw new Error("Capture environment identity mismatch");
	}
	const canonical = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "environment_id"));
	if (sha256(stableJson(canonical)) !== value.environment_id)
		throw new Error("Capture environment ID is not canonical");
	if (
		!isRecord(value.os) ||
		value.os.platform !== "darwin" ||
		typeof value.os.version !== "string" ||
		!value.os.version ||
		typeof value.os.build !== "string" ||
		!value.os.build ||
		typeof value.architecture !== "string" ||
		!value.architecture ||
		typeof value.bun_version !== "string" ||
		!value.bun_version
	) {
		throw new Error("Capture host identity is incomplete or non-Darwin");
	}
	const lockfile = manifest.source_files.find(file => file.path === "bun.lock");
	if (!lockfile || value.lockfile_sha256 !== lockfile.sha256) throw new Error("Capture lockfile identity mismatch");
	if (
		!isRecord(value.resvg) ||
		value.resvg.package_version !== "2.6.2" ||
		!isSha256(value.resvg.package_sha256) ||
		!isSha256(value.resvg.native_binary_sha256) ||
		typeof value.resvg.native_binary_path !== "string" ||
		!value.resvg.native_binary_path
	) {
		throw new Error("Capture Resvg identity is incomplete");
	}
	if (
		value.evidence_helper_version !== TERMINAL_EVIDENCE_VERSION ||
		value.ansi_parser_version !== "gjc-sgr-cell-grid-v1" ||
		value.svg_serializer_version !== "gjc-fixed-cell-svg-v1" ||
		value.time_zone !== "UTC" ||
		!isRecord(value.locale) ||
		value.locale.lang !== "en_US.UTF-8" ||
		value.locale.lc_all !== "en_US.UTF-8"
	) {
		throw new Error("Capture renderer environment contract mismatch");
	}
	if (stableJson(value.fonts) !== stableJson(CANONICAL_DARWIN_FONTS))
		throw new Error("Capture font authority mismatch");
	if (stableJson(value.cell_geometry) !== stableJson(CELL_GEOMETRY)) throw new Error("Capture cell geometry mismatch");
	if (
		!isRecord(value.color_profile) ||
		value.color_profile.name !== "sRGB" ||
		value.color_profile.source !== "fixed SVG/Resvg raster contract"
	) {
		throw new Error("Capture color profile mismatch");
	}
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	return value;
}

function requiredArtifactFile(entry: ArtifactEntry, filename: (typeof EVIDENCE_ENTRY_FILENAMES)[number]): ArtifactFile {
	const file = entry.files.find(candidate => path.posix.basename(candidate.path) === filename);
	if (!file) throw new Error(`Missing ${filename} for ${entry.key}`);
	return file;
}

async function readArtifactBytes(evidenceRoot: string, file: ArtifactFile): Promise<Uint8Array> {
	const bytes = new Uint8Array(await Bun.file(path.join(evidenceRoot, file.path)).arrayBuffer());
	if (bytes.byteLength !== file.byte_length || sha256(bytes) !== file.sha256) {
		throw new Error(`Artifact integrity mismatch: ${file.path}`);
	}
	return bytes;
}

function independentlyExtractHtmlPlainText(html: string): string {
	const match = /<body><pre>([\s\S]*)<\/pre><\/body>\n<\/html>\n$/.exec(html);
	if (!match) throw new Error("HTML evidence envelope is invalid");
	const encoded = match[1]!
		.replace(/<span data-c="\d+" data-span="[12]" style="[^"]*">/g, "")
		.replaceAll("</span>", "");
	if (encoded.includes("<") || /&(?:#|[A-Za-z])/.test(encoded.replace(/&(?:amp|lt|gt|quot);/g, ""))) {
		throw new Error("HTML evidence contains an unexpected tag or entity");
	}
	return `${encoded
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&amp;", "&")}\n`;
}

async function validateEvidenceEntry(
	evidenceRoot: string,
	entry: ArtifactEntry,
	manifest: ArtifactManifest,
): Promise<void> {
	const decoder = new TextDecoder();
	const textFile = requiredArtifactFile(entry, "terminal.txt");
	const ansiFile = requiredArtifactFile(entry, "terminal-ansi.txt");
	const htmlFile = requiredArtifactFile(entry, "terminal.html");
	const metadataFile = requiredArtifactFile(entry, "metadata.json");
	const pngFile = requiredArtifactFile(entry, "terminal.png");
	const [textBytes, ansiBytes, htmlBytes, metadataBytes, pngBytes] = await Promise.all([
		readArtifactBytes(evidenceRoot, textFile),
		readArtifactBytes(evidenceRoot, ansiFile),
		readArtifactBytes(evidenceRoot, htmlFile),
		readArtifactBytes(evidenceRoot, metadataFile),
		readArtifactBytes(evidenceRoot, pngFile),
	]);
	const terminalText = decoder.decode(textBytes);
	const terminalAnsi = decoder.decode(ansiBytes);
	const terminalHtml = decoder.decode(htmlBytes);
	const canonicalEntry = LIGHT_THEME_COMPLIANCE_ENTRIES.find(candidate => candidate.key === entry.key);
	if (!canonicalEntry) throw new Error(`Unknown canonical evidence entry: ${entry.key}`);
	const currentRender = await renderLightThemeComplianceShowcase(canonicalEntry);
	if (
		currentRender.terminalText !== terminalText ||
		currentRender.terminalAnsiText !== terminalAnsi ||
		currentRender.themeIdentity.requestedTheme !== entry.theme ||
		currentRender.themeIdentity.resolvedTheme !== entry.theme ||
		currentRender.themeIdentity.keyTheme !== entry.theme ||
		currentRender.themeIdentity.themeSentinelSha256 !== entry.theme_sentinel_sha256
	) {
		throw new Error(`Evidence does not match the current production render for ${entry.key}`);
	}
	if (Bun.stripANSI(terminalAnsi) !== terminalText) {
		throw new Error(`Independent ANSI/text fidelity mismatch for ${entry.key}`);
	}
	if (independentlyExtractHtmlPlainText(terminalHtml) !== terminalText) {
		throw new Error(`Independent HTML/text fidelity mismatch for ${entry.key}`);
	}
	const metadata = requiredRecord(JSON.parse(decoder.decode(metadataBytes)) as unknown, `Metadata ${entry.key}`);
	const theme = requiredRecord(metadata.theme, `Metadata theme ${entry.key}`);
	const rawRoles = requiredRecord(theme.theme_sentinel_roles, `Metadata theme roles ${entry.key}`);
	const roles = Object.fromEntries(
		Object.entries(rawRoles).map(([role, color]) => {
			if (typeof color !== "string") throw new Error(`Metadata theme role ${role} is invalid for ${entry.key}`);
			return [role, color];
		}),
	);
	if (
		typeof theme.requested_theme !== "string" ||
		typeof theme.resolved_theme !== "string" ||
		typeof theme.manifest_key_theme !== "string" ||
		typeof theme.theme_sentinel_sha256 !== "string" ||
		typeof theme.page_background !== "string"
	) {
		throw new Error(`Metadata theme identity is incomplete for ${entry.key}`);
	}
	assertThemeEvidenceIdentity(
		{
			requestedTheme: theme.requested_theme,
			resolvedTheme: theme.resolved_theme,
			keyTheme: theme.manifest_key_theme,
			themeSentinelRoles: roles,
			themeSentinelSha256: theme.theme_sentinel_sha256,
			pageBackground: theme.page_background,
		},
		entry.theme,
	);
	const grid = parseAnsiCellGrid(
		terminalAnsi,
		entry.viewport.columns,
		entry.viewport.rows,
		roles.text!,
		theme.page_background,
	);
	if (
		grid.plainText !== terminalText ||
		grid.sha256 !== entry.cell_grid_sha256 ||
		grid.occupancySha256 !== entry.occupancy_sha256
	) {
		throw new Error(`ANSI/text cell-grid fidelity mismatch for ${entry.key}`);
	}
	const expectedHtml = cellGridToHtml(grid, entry.theme, entry.theme_sentinel_sha256, theme.page_background);
	if (terminalHtml !== expectedHtml) throw new Error(`HTML fidelity mismatch for ${entry.key}`);
	assertHtmlThemeIdentity(terminalHtml, entry.theme, entry.theme_sentinel_sha256);
	const display = cellGridToSvg(grid, entry.theme, entry.theme_sentinel_sha256, roles, theme.page_background);
	if (display.displayListSha256 !== entry.display_list_sha256) {
		throw new Error(`Display-list fidelity mismatch for ${entry.key}`);
	}
	const decodedPng = decodePngRgba(pngBytes);
	const expectedWidth = entry.viewport.columns * CELL_GEOMETRY.cellWidthPx + CELL_GEOMETRY.horizontalPaddingPx * 2;
	const expectedHeight = entry.viewport.rows * CELL_GEOMETRY.cellHeightPx + CELL_GEOMETRY.verticalPaddingPx * 2;
	if (
		decodedPng.width !== expectedWidth ||
		decodedPng.height !== expectedHeight ||
		!decodedPng.nonUniform ||
		decodedPng.decodedRgbaSha256 !== entry.decoded_rgba_sha256
	) {
		throw new Error(`PNG dimensions/RGBA mismatch for ${entry.key}`);
	}
	const metadataPng = requiredRecord(metadata.png, `Metadata PNG ${entry.key}`);
	if (
		metadataPng.width !== expectedWidth ||
		metadataPng.height !== expectedHeight ||
		metadataPng.byte_sha256 !== pngFile.sha256 ||
		metadataPng.decoded_rgba_sha256 !== decodedPng.decodedRgbaSha256 ||
		metadataPng.non_uniform !== true ||
		!Array.isArray(metadataPng.sentinel_samples)
	) {
		throw new Error(`PNG metadata mismatch for ${entry.key}`);
	}
	exactStringSet(
		metadataPng.sentinel_samples.map((sample, index) => {
			const record = requiredRecord(sample, `PNG sentinel ${entry.key}[${index}]`);
			if (
				typeof record.role !== "string" ||
				!Number.isSafeInteger(record.x) ||
				!Number.isSafeInteger(record.y) ||
				typeof record.rgb !== "string" ||
				pngPixelHex(decodedPng.pixels, decodedPng.width, Number(record.x), Number(record.y)).toLowerCase() !==
					record.rgb.toLowerCase()
			) {
				throw new Error(`PNG sentinel mismatch for ${entry.key}[${index}]`);
			}
			return record.role;
		}),
		display.samples.map(sample => sample.role),
		`PNG sentinel roles for ${entry.key}`,
	);
	if (
		metadata.entry_key !== entry.key ||
		metadata.scene_id !== entry.scene_id ||
		metadata.render_mode !== entry.render_mode ||
		metadata.environment_id !== manifest.environment_id ||
		metadata.source_revision !== manifest.source_revision ||
		metadata.source_fingerprint !== manifest.source_fingerprint
	) {
		throw new Error(`Metadata authority mismatch for ${entry.key}`);
	}
	if (entry.render_mode === "ascii-no-color" && terminalAnsi.includes("\x1b")) {
		throw new Error(`No-color evidence contains ANSI for ${entry.key}`);
	}
	if (entry.render_mode === "unicode-256-color" && /\x1b\[(?:\d+;)*(?:38|48);2;/.test(terminalAnsi)) {
		throw new Error(`ANSI-256 evidence contains truecolor for ${entry.key}`);
	}
}

describe("GJC light-theme compliance fixture", () => {
	it("defines the exact 180-key matrix without gaps or duplicates", () => {
		expect(LIGHT_THEME_COMPLIANCE_SCENE_IDS).toHaveLength(25);
		expect(LIGHT_THEME_COMPLIANCE_ENTRIES).toHaveLength(LIGHT_THEME_COMPLIANCE_EXPECTED_ENTRY_COUNT);
		expect(new Set(LIGHT_THEME_COMPLIANCE_ENTRIES.map(entry => entry.key)).size).toBe(
			LIGHT_THEME_COMPLIANCE_EXPECTED_ENTRY_COUNT,
		);
		for (const themeName of LIGHT_THEME_COMPLIANCE_THEMES) {
			expect(LIGHT_THEME_COMPLIANCE_ENTRIES.filter(entry => entry.theme === themeName)).toHaveLength(90);
		}
		expect(LIGHT_THEME_COMPLIANCE_ENTRIES.filter(entry => entry.renderMode === "ascii-no-color")).toHaveLength(12);
		expect(
			LIGHT_THEME_COMPLIANCE_ENTRIES.filter(
				entry => entry.viewport.id === "48x36" && entry.renderMode === "unicode-color",
			),
		).toHaveLength(8);
		expect(LIGHT_THEME_COMPLIANCE_ASCII_NO_COLOR_SCENES).toHaveLength(6);
		expect(LIGHT_THEME_COMPLIANCE_CJK_SCENES).toHaveLength(4);
		const atlasEntries = LIGHT_THEME_COMPLIANCE_ENTRIES.filter(entry => entry.sceneId === "consumer-atlas");
		expect(atlasEntries).toHaveLength(8);
		const truecolorAtlasEntries = atlasEntries.filter(entry => entry.renderMode === "unicode-color");
		expect(truecolorAtlasEntries.map(entry => entry.viewport.columns).sort((a, b) => a - b)).toEqual([
			80, 80, 120, 120, 160, 160,
		]);
		for (const themeName of LIGHT_THEME_COMPLIANCE_THEMES) {
			const themeAtlas = truecolorAtlasEntries.filter(entry => entry.theme === themeName);
			expect(themeAtlas).toHaveLength(3);
			expect(themeAtlas.map(entry => entry.viewport.columns).sort((a, b) => a - b)).toEqual([80, 120, 160]);
		}
		expect(LIGHT_THEME_COMPLIANCE_ANSI_256_SCENES).toEqual([
			"selected-focus-active",
			"wrap-mixed-cjk-latin",
			"consumer-atlas",
		]);
		const ansi256Entries = LIGHT_THEME_COMPLIANCE_ENTRIES.filter(entry => entry.renderMode === "unicode-256-color");
		expect(ansi256Entries).toHaveLength(10);
		expect(new Set(ansi256Entries.map(entry => entry.theme))).toEqual(new Set(LIGHT_THEME_COMPLIANCE_THEMES));
		expect(
			ansi256Entries.filter(entry => entry.sceneId === "selected-focus-active").map(entry => entry.viewport.columns),
		).toEqual([80, 120, 160, 80, 120, 160]);
		expect(ansi256Entries.filter(entry => entry.sceneId === "wrap-mixed-cjk-latin")).toHaveLength(2);
		expect(ansi256Entries.filter(entry => entry.sceneId === "consumer-atlas")).toHaveLength(2);
	});

	it("uses the live repository-controlled editor schema for both bundled light themes", async () => {
		const schemaUrl =
			"https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/dev/packages/coding-agent/src/modes/theme/theme-schema.json";
		for (const themeName of LIGHT_THEME_COMPLIANCE_THEMES) {
			const themePath = path.join(import.meta.dir, "../src/modes/theme/defaults", `${themeName}.json`);
			const themeJson = JSON.parse(await Bun.file(themePath).text()) as { $schema?: unknown };
			expect(themeJson.$schema).toBe(schemaUrl);
		}
	});
	it("rejects forged manifest sets, paths, and author identities without relying on counts", () => {
		const valid = makeManifestFixture();
		validateManifestContract(valid);

		const forgedKey = structuredClone(valid);
		forgedKey.entries[0]!.key = `forged/${forgedKey.entries[0]!.key}`;
		expect(() => validateManifestContract(forgedKey)).toThrow("exact canonical set");

		const forgedPath = structuredClone(valid);
		forgedPath.entries[0]!.files[0]!.path = "../escaped/terminal.txt";
		expect(() => validateManifestContract(forgedPath)).toThrow("unsafe");
		const staleTool = structuredClone(valid);
		staleTool.capture_tool = "gjc-light-theme-compliance-v2";
		expect(() => validateManifestContract(staleTool)).toThrow("authority or count contract");

		const forgedMatrix = structuredClone(valid);
		forgedMatrix.matrix = { ...forgedMatrix.matrix, canonical_viewports: [] };
		expect(() => validateManifestContract(forgedMatrix)).toThrow("viewport matrix");

		const unknownNested = structuredClone(valid);
		(unknownNested.entries[0]!.files[0] as ArtifactFile & { unexpected?: boolean }).unexpected = true;
		expect(() => readManifest(unknownNested)).toThrow("fields");

		const emptyAuthors = structuredClone(valid) as unknown as Record<string, unknown>;
		emptyAuthors.author_identities = {
			implementation_author_ids: [],
			capture_author_ids: [],
		};
		expect(() => readManifest(emptyAuthors)).toThrow("canonical identities");
	});
	it("invalidates the source authority after any bound source mutation", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-light-source-"));
		try {
			await Bun.write(path.join(root, "renderer.ts"), "export const color = '#ffffff';\n");
			await Bun.write(path.join(root, "validator.ts"), "export const valid = true;\n");
			const paths = ["renderer.ts", "validator.ts"];
			const first = await fingerprintEvidenceSourceFiles(root, paths);
			await Bun.write(path.join(root, "renderer.ts"), "export const color = '#fffffe';\n");
			const second = await fingerprintEvidenceSourceFiles(root, paths);
			expect(second.source_fingerprint).not.toBe(first.source_fingerprint);
			expect(second.source_files.find(file => file.path === "renderer.ts")?.sha256).not.toBe(
				first.source_files.find(file => file.path === "renderer.ts")?.sha256,
			);
			await fs.symlink(path.join(root, "validator.ts"), path.join(root, "alias.ts"));
			await expect(fingerprintEvidenceSourceFiles(root, ["alias.ts"])).rejects.toThrow("real files");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
	it("rejects a self-consistent but incomplete source authority", async () => {
		const repoRoot = path.resolve(import.meta.dir, "../../..");
		const currentSource = await captureSourceFingerprint(repoRoot);
		const manifest = makeManifestFixture();
		manifest.source_files = [...currentSource.source_files];
		manifest.source_fingerprint = currentSource.source_fingerprint;
		manifest.source_revision = currentSource.source_revision;
		validateManifestContract(manifest);
		validateCurrentSourceAuthority(manifest, currentSource);
		const currentPaths = currentSource.source_files.map(file => file.path);
		expect(currentPaths).toContain(".github/workflows/dev-ci.yml");
		expect(currentPaths).toContain("packages/coding-agent/src/modes/theme/defaults/blue-crab.json");
		expect(currentPaths).toContain("packages/coding-agent/src/modes/theme/defaults/red-claw.json");
		expect(currentPaths).toContain("packages/coding-agent/scripts/ci-light-theme-evidence.ts");
		expect(currentPaths).toContain("packages/coding-agent/src/internal-urls/docs-index.generated.ts");
		expect(currentPaths).toContain("packages/coding-agent/src/modes/jobs-observer.ts");
		expect(currentPaths).toContain("packages/agent/src/thinking.ts");
		expect(currentPaths).toContain("packages/ai/src/model-thinking.ts");
		expect(currentPaths.some(candidate => candidate.startsWith("packages/tui/src/"))).toBe(true);
		expect(currentPaths.some(candidate => candidate.startsWith("packages/natives/scripts/"))).toBe(true);
		expect(currentPaths.some(candidate => candidate.startsWith("crates/pi-natives/src/"))).toBe(true);

		const forged = structuredClone(manifest);
		forged.source_files.pop();
		forged.source_fingerprint = sha256(stableJson(forged.source_files));
		forged.source_revision = `${currentSource.source_revision.slice(0, 40)}+worktree:${forged.source_fingerprint}`;
		expect(() => validateManifestContract(forged)).not.toThrow();
		expect(() => validateCurrentSourceAuthority(forged, currentSource)).toThrow("exact current source closure");
	});
	it("renders every key through the declared production surface with fail-closed identity", async () => {
		for (const entry of LIGHT_THEME_COMPLIANCE_ENTRIES) {
			const rendered = await renderLightThemeComplianceShowcase(entry);
			expect(rendered.key).toBe(entry.key);
			expect(rendered.themeIdentity.requestedTheme).toBe(entry.theme);
			expect(rendered.themeIdentity.resolvedTheme).toBe(entry.theme);
			expect(rendered.themeIdentity.keyTheme).toBe(entry.theme);
			expect(rendered.themeIdentity.themeSentinelSha256).toMatch(/^[a-f0-9]{64}$/);
			expect(rendered.terminalText.split("\n")).toHaveLength(entry.viewport.rows + 1);
			expect(rendered.provenance.productionImports.length).toBeGreaterThan(0);
			expect(rendered.provenance.productionSymbols.length).toBeGreaterThan(0);
			if (entry.renderMode === "ascii-no-color") {
				expect(rendered.terminalAnsiText).not.toContain("\x1b");
				expect(rendered.provenance.noColorCues?.length).toBeGreaterThan(1);
			}
		}
	}, 30_000);

	it("renders deterministic 256-color downsampling with unchanged text and non-color cues", async () => {
		const ansi256Entries = LIGHT_THEME_COMPLIANCE_ENTRIES.filter(entry => entry.renderMode === "unicode-256-color");
		for (const entry of ansi256Entries) {
			const rendered = await renderLightThemeComplianceShowcase(entry);
			expect(rendered.terminalAnsiText, entry.key).toMatch(/\x1b\[(?:\d+;)*(?:38|48);5;\d+m/);
			expect(rendered.terminalAnsiText, entry.key).not.toMatch(/\x1b\[(?:\d+;)*(?:38|48);2;/);
			const truecolorEntry = LIGHT_THEME_COMPLIANCE_ENTRIES.find(
				candidate =>
					candidate.theme === entry.theme &&
					candidate.sceneId === entry.sceneId &&
					candidate.viewport.id === entry.viewport.id &&
					candidate.renderMode === "unicode-color",
			);
			expect(truecolorEntry, `${entry.key} needs a truecolor counterpart`).toBeDefined();
			const truecolor = await renderLightThemeComplianceShowcase(truecolorEntry!);
			expect(rendered.terminalText, entry.key).toBe(truecolor.terminalText);
			if (entry.sceneId === "wrap-mixed-cjk-latin") {
				expect(rendered.terminalText).toContain("알림");
				expect(rendered.terminalText).toContain("通知");
			} else if (entry.sceneId === "consumer-atlas") {
				expect(rendered.terminalText).toContain("Provider onboarding");
				expect(rendered.terminalText).toContain("showcase-pending");
				expect(rendered.terminalText).toContain("showcase-error");
			} else {
				expect(rendered.terminalText).toContain("ACTIVE");
			}
		}
	}, 30_000);

	it("rejects manifest-key and closed-theme mismatches", async () => {
		const first = LIGHT_THEME_COMPLIANCE_ENTRIES[0]!;
		await expect(renderLightThemeComplianceShowcase({ ...first, key: `wrong/${first.key}` })).rejects.toThrow(
			"key mismatch",
		);
		const invalid = { ...first, theme: "red-claw" } as unknown as LightThemeComplianceEntry;
		await expect(renderLightThemeComplianceShowcase(invalid)).rejects.toThrow("rejects non-closed theme request");
	});

	it("rejects resolved, key, role, sentinel, and HTML identity mutations", async () => {
		const first = LIGHT_THEME_COMPLIANCE_ENTRIES[0]!;
		const rendered = await renderLightThemeComplianceShowcase(first);
		const identity = rendered.themeIdentity;

		expect(() => assertThemeEvidenceIdentity({ ...identity, resolvedTheme: "blue-crab-light" }, first.theme)).toThrow(
			"Theme identity mismatch",
		);
		expect(() => assertThemeEvidenceIdentity({ ...identity, keyTheme: "blue-crab-light" }, first.theme)).toThrow(
			"Theme identity mismatch",
		);
		expect(() =>
			assertThemeEvidenceIdentity(
				{ ...identity, themeSentinelRoles: { ...identity.themeSentinelRoles, text: "#000000" } },
				first.theme,
			),
		).toThrow("Theme sentinel mismatch");
		expect(() =>
			assertThemeEvidenceIdentity({ ...identity, themeSentinelSha256: "0".repeat(64) }, first.theme),
		).toThrow("Theme sentinel mismatch");
		expect(() => assertThemeEvidenceIdentity({ ...identity, pageBackground: "#ffffff" }, first.theme)).toThrow(
			"background role",
		);

		const html = `<html data-theme="${first.theme}" data-theme-sentinel="${identity.themeSentinelSha256}"></html>`;
		assertHtmlThemeIdentity(html, first.theme, identity.themeSentinelSha256);
		expect(() =>
			assertHtmlThemeIdentity(
				html.replace(first.theme, "blue-crab-light"),
				first.theme,
				identity.themeSentinelSha256,
			),
		).toThrow("HTML identity mismatch");
		expect(() =>
			assertHtmlThemeIdentity(
				html.replace(identity.themeSentinelSha256, "0".repeat(64)),
				first.theme,
				identity.themeSentinelSha256,
			),
		).toThrow("HTML identity mismatch");
	});

	it("proves actual maxVisible top, middle, and bottom boundaries with stable frame rows", async () => {
		for (const themeName of LIGHT_THEME_COMPLIANCE_THEMES) {
			for (const viewport of LIGHT_THEME_COMPLIANCE_VIEWPORTS) {
				const triplet = [];
				for (const sceneId of ["overflow-top", "overflow-middle", "overflow-bottom"] as const) {
					const entry = LIGHT_THEME_COMPLIANCE_ENTRIES.find(
						candidate =>
							candidate.theme === themeName &&
							candidate.sceneId === sceneId &&
							candidate.viewport.id === viewport.id &&
							candidate.renderMode === "unicode-color",
					)!;
					triplet.push(await renderLightThemeComplianceShowcase(entry));
				}
				const [top, middle, bottom] = triplet;
				expect(top!.window?.windowStart).toBe(0);
				expect(top!.window?.selectedIndex).toBe(0);
				expect(middle!.window?.windowStart).toBeGreaterThan(0);
				expect(middle!.window?.windowEnd).toBeLessThan(11);
				expect(bottom!.window?.windowEnd).toBe(11);
				expect(bottom!.window?.selectedIndex).toBe(10);
				expect(top!.window?.stickyTopRowIds).toEqual(middle!.window?.stickyTopRowIds);
				expect(middle!.window?.stickyBottomRowIds).toEqual(bottom!.window?.stickyBottomRowIds);
				const rowSets = triplet.map(rendered => rendered.terminalText.split("\n"));
				expect(rowSets[0]!.slice(0, 3)).toEqual(rowSets[1]!.slice(0, 3));
				expect(rowSets[1]!.at(-2)).toBe(rowSets[2]!.at(-2));
			}
		}
	});

	it("preserves CJK semantic units at every required width", async () => {
		const expected = {
			"wrap-korean": ["복원 선택", "secret=••••••••", "cfg.path=/showcase/config.yml"],
			"wrap-japanese": [
				"ブロックしました。",
				"明示的に選択する必要があります。",
				"復元を選択",
				"secret=••••••••",
				"cfg.path=/showcase/config.yml",
			],
			"wrap-chinese": ["选择恢复", "secret=••••••••", "cfg.path=/showcase/config.yml"],
			"wrap-mixed-cjk-latin": ["Restore · 복원 · 復元 · 恢复", "secret=••••••••", "cfg.path=/showcase/config.yml"],
		} as const;
		for (const entry of LIGHT_THEME_COMPLIANCE_ENTRIES.filter(candidate =>
			(LIGHT_THEME_COMPLIANCE_CJK_SCENES as readonly string[]).includes(candidate.sceneId),
		)) {
			const rendered = await renderLightThemeComplianceShowcase(entry);
			for (const semanticUnit of expected[entry.sceneId as keyof typeof expected]) {
				expect(rendered.terminalText, `${entry.key} broke ${semanticUnit}`).toContain(semanticUnit);
			}
			expect(rendered.terminalText).not.toContain("�");
		}
	});

	it("parses ANSI into an ANSI-free grapheme-aware canonical cell grid", () => {
		const grid = parseAnsiCellGrid("\x1b[38;2;7;91;158m한A\x1b[0m\n", 8, 2, "#0e2436", "#f5fafd");
		expect(grid.plainText).toBe("한A\n\n");
		expect(grid.cells.find(cell => cell.grapheme === "한")?.span).toBe(2);
		expect(grid.cells.find(cell => cell.grapheme === "A")?.column).toBe(2);
		expect(grid.sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(grid.occupancySha256).toMatch(/^[a-f0-9]{64}$/);
		const html = cellGridToHtml(grid, "red-claw-light", "a".repeat(64), "#f5fafd");
		expect(independentlyExtractHtmlPlainText(html)).toBe(grid.plainText);
		expect(() => independentlyExtractHtmlPlainText(html.replace("</pre>", "<script>forged</script></pre>"))).toThrow(
			"unexpected tag",
		);
	});

	it("validates Resvg PNG structure and sentinel samples fail closed", () => {
		const svg =
			'<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="2" height="4" fill="#ff0000"/><rect x="2" width="2" height="4" fill="#0000ff"/></svg>';
		expect(() => rasterizeSvg(svg, [], [{ role: "background", x: 0, y: 0, rgb: "#00ff00" }])).toThrow(
			"PNG sentinel background mismatch",
		);
		const png = rasterizeSvg(svg, [], [{ role: "background", x: 0, y: 0, rgb: "#ff0000" }]);
		expect(png.width).toBe(4);
		expect(png.height).toBe(4);
		expect(png.nonUniform).toBe(true);
		expect([...png.bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
		const decoded = decodePngRgba(png.bytes);
		expect(decoded.width).toBe(4);
		expect(decoded.height).toBe(4);
		expect(decoded.nonUniform).toBe(true);
		expect(decoded.decodedRgbaSha256).toBe(png.decodedRgbaSha256);
		expect(pngPixelHex(decoded.pixels, decoded.width, 0, 0)).toBe("#ff0000");
		const tampered = png.bytes.slice();
		tampered[Math.floor(tampered.byteLength / 2)]! ^= 1;
		expect(() => decodePngRgba(tampered)).toThrow();
	});
	it("renders consumer-atlas through production components with exact provenance", async () => {
		const requiredSymbols = [
			"ProviderOnboardingSelectorComponent",
			"AssistantMessageComponent",
			"UserMessageComponent",
			"CustomMessageComponent",
			"ToolExecutionComponent",
			"BashExecutionComponent",
			"EvalExecutionComponent",
			"WelcomeComponent",
			"TreeSelectorComponent",
			"getThinkingBorderColor",
		] as const;
		const atlasEntries = LIGHT_THEME_COMPLIANCE_ENTRIES.filter(entry => entry.sceneId === "consumer-atlas");
		expect(atlasEntries).toHaveLength(8);
		for (const entry of atlasEntries) {
			const rendered = await renderLightThemeComplianceShowcase(entry);
			expect(rendered.provenance.sceneFamily).toBe("consumer-atlas");
			for (const symbol of requiredSymbols) {
				expect(rendered.provenance.productionSymbols).toContain(symbol);
			}
			const text = rendered.terminalText;
			expect(text).toContain("Provider onboarding");
			expect(text).toContain("gajae");
			expect(text).toContain("Atlas assistant body");
			expect(text).toContain("showcase provider error");
			expect(text).toContain("Atlas user prompt");
			expect(text).toContain("[atlas-skill]");
			expect(text).toContain("showcase-pending");
			expect(text).toContain("printf pending");
			expect(text).toContain("tool success output");
			expect(text).toContain("tool error output");
			expect(text).toContain("printf atlas-bash");
			expect(text).toContain("atlas bash stdout");
			expect(text).toContain('print("atlas-eval")');
			expect(text).toContain("atlas eval stdout");
			expect(text).toContain("GJC Forge");
			expect(text).toContain("[compaction: 10k tokens]");
			expect(text).toContain("128");
			expect(text).toContain("64");
			expect(text).toContain("thinking-off");
			expect(text).toContain("thinking-minimal");
			expect(text).toContain("thinking-low");
			expect(text).toContain("thinking-medium");
			expect(text).toContain("thinking-high");
			expect(text).toContain("thinking-xhigh");
		}
	}, 30_000);
});

describe("generated light-theme compliance evidence", () => {
	it("validates canonical evidence and the independent receipt fail-closed", async () => {
		const evidenceRoot = Bun.env.GJC_LIGHT_THEME_EVIDENCE;
		if (!evidenceRoot) {
			if (Bun.env.GJC_LIGHT_THEME_EVIDENCE_REQUIRED === "1") {
				throw new Error("GJC_LIGHT_THEME_EVIDENCE is required by the canonical CI evidence gate");
			}
			return;
		}
		const manifestPath = path.join(evidenceRoot, "manifest.json");
		const manifestBytes = new Uint8Array(await Bun.file(manifestPath).arrayBuffer());
		const manifestSha256 = sha256(manifestBytes);
		const manifest = readManifest(JSON.parse(new TextDecoder().decode(manifestBytes)) as unknown);
		validateManifestContract(manifest);
		const repoRoot = path.resolve(import.meta.dir, "../../..");
		const currentSource = await captureSourceFingerprint(repoRoot);
		validateCurrentSourceAuthority(manifest, currentSource);

		const environment = JSON.parse(
			await Bun.file(path.join(evidenceRoot, "capture-environment.json")).text(),
		) as unknown;
		validateCaptureEnvironment(environment, manifest);
		for (const entry of manifest.entries) await validateEvidenceEntry(evidenceRoot, entry, manifest);

		const reviewInput = requiredRecord(
			JSON.parse(await Bun.file(path.join(evidenceRoot, "review-input.json")).text()) as unknown,
			"Review input",
		);
		exactObjectKeys(
			reviewInput,
			[
				"schema_version",
				"manifest_path",
				"manifest_sha256",
				"source_revision",
				"environment_id",
				"author_identities",
				"expected_entry_count",
				"expected_leaf_count",
				"reviewed_entry_keys",
				"reviewer_output_file",
				"requirements",
			],
			"Review input",
		);
		if (
			reviewInput.schema_version !== 2 ||
			reviewInput.manifest_path !== "manifest.json" ||
			reviewInput.manifest_sha256 !== manifestSha256 ||
			reviewInput.source_revision !== manifest.source_revision ||
			reviewInput.environment_id !== manifest.environment_id ||
			reviewInput.expected_entry_count !== manifest.entry_count ||
			reviewInput.expected_leaf_count !== manifest.leaf_count ||
			reviewInput.reviewer_output_file !== "independent-review.json" ||
			!isRecord(reviewInput.author_identities)
		) {
			throw new Error("Review input is not bound to the exact evidence authority");
		}
		exactObjectKeys(
			reviewInput.author_identities,
			["implementation_author_ids", "capture_author_ids"],
			"Review-input author identities",
		);
		exactStringSet(
			stringArray(reviewInput.requirements, "review-input requirements"),
			LIGHT_THEME_EVIDENCE_REVIEW_REQUIREMENTS,
			"Review-input requirements",
		);
		exactStringSet(
			authorIdentityArray(
				reviewInput.author_identities.implementation_author_ids,
				"review-input implementation authors",
			),
			manifest.author_identities.implementation_author_ids,
			"Review-input implementation authors",
		);
		exactStringSet(
			authorIdentityArray(reviewInput.author_identities.capture_author_ids, "review-input capture authors"),
			manifest.author_identities.capture_author_ids,
			"Review-input capture authors",
		);
		exactStringSet(
			stringArray(reviewInput.reviewed_entry_keys, "review-input entry keys"),
			manifest.entries.map(entry => entry.key),
			"Review-input entry keys",
		);

		const runReceipt = requiredRecord(
			JSON.parse(await Bun.file(path.join(evidenceRoot, "run-receipt.json")).text()) as unknown,
			"Capture run receipt",
		);
		exactObjectKeys(
			runReceipt,
			[
				"schema_version",
				"captured_at",
				"elapsed_ms",
				"output_path",
				"manifest_sha256",
				"source_revision",
				"environment_id",
				"entry_count",
				"leaf_count",
				"cleanup_status",
			],
			"Capture run receipt",
		);
		if (
			runReceipt.schema_version !== 2 ||
			typeof runReceipt.captured_at !== "string" ||
			runReceipt.output_path !== LIGHT_THEME_EVIDENCE_CANONICAL_OUTPUT ||
			Number.isNaN(Date.parse(runReceipt.captured_at)) ||
			Date.parse(runReceipt.captured_at) > Date.now() + 5 * 60_000 ||
			!Number.isSafeInteger(runReceipt.elapsed_ms) ||
			Number(runReceipt.elapsed_ms) < 0 ||
			runReceipt.manifest_sha256 !== manifestSha256 ||
			runReceipt.source_revision !== manifest.source_revision ||
			runReceipt.environment_id !== manifest.environment_id ||
			runReceipt.entry_count !== manifest.entry_count ||
			runReceipt.leaf_count !== manifest.leaf_count ||
			runReceipt.cleanup_status !== "complete"
		) {
			throw new Error("Capture run receipt is incomplete or stale");
		}
		const capturedAt = runReceipt.captured_at;
		const reviewPath = path.join(evidenceRoot, "independent-review.json");
		if (!(await Bun.file(reviewPath).exists())) throw new Error("Independent review receipt is missing");
		const review = JSON.parse(await Bun.file(reviewPath).text()) as unknown;
		validateIndependentReview(review, manifest, manifestSha256, capturedAt);
		if (!isRecord(review)) throw new Error("Independent review must be an object");
		const expectRejectedReview = (mutate: (candidate: Record<string, unknown>) => void): void => {
			const candidate = structuredClone(review);
			mutate(candidate);
			expect(() => validateIndependentReview(candidate, manifest, manifestSha256, capturedAt)).toThrow();
		};
		expectRejectedReview(candidate => {
			candidate.unexpected = true;
		});
		expectRejectedReview(candidate => {
			const binding = candidate.manifest;
			if (!isRecord(binding)) throw new Error("Review manifest binding is missing");
			candidate.manifest = { ...binding, sha256: "0".repeat(64) };
		});
		expectRejectedReview(candidate => {
			const inspection = candidate.inspection;
			if (!isRecord(inspection)) throw new Error("Review inspection is missing");
			candidate.inspection = { ...inspection, reviewed_entry_keys: [] };
		});
		expectRejectedReview(candidate => {
			const independence = candidate.independence;
			if (!isRecord(independence)) throw new Error("Review independence is missing");
			candidate.independence = { ...independence, implementation_author_ids: [] };
		});
		expectRejectedReview(candidate => {
			const reviewer = candidate.reviewer;
			const independence = candidate.independence;
			if (!isRecord(reviewer) || typeof reviewer.id !== "string" || !isRecord(independence)) {
				throw new Error("Review identity or independence is missing");
			}
			candidate.independence = { ...independence, implementation_author_ids: [reviewer.id] };
		});
		expectRejectedReview(candidate => {
			candidate.findings = [
				{
					id: "tampered-finding",
					severity: "blocker",
					entry_keys: [manifest.entries[0]!.key],
					description: "Unresolved tamper fixture",
					disposition: "unresolved",
				},
			];
		});
	}, 120_000);
});
