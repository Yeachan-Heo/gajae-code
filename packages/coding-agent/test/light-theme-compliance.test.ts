import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	assertHtmlThemeIdentity,
	assertThemeEvidenceIdentity,
	captureSourceFingerprint,
	parseAnsiCellGrid,
	rasterizeSvg,
	sha256,
} from "../scripts/lib/terminal-visual-evidence";
import {
	LIGHT_THEME_COMPLIANCE_ASCII_NO_COLOR_SCENES,
	LIGHT_THEME_COMPLIANCE_CJK_SCENES,
	LIGHT_THEME_COMPLIANCE_ENTRIES,
	LIGHT_THEME_COMPLIANCE_EXPECTED_ENTRY_COUNT,
	LIGHT_THEME_COMPLIANCE_SCENE_IDS,
	LIGHT_THEME_COMPLIANCE_THEMES,
	LIGHT_THEME_COMPLIANCE_VIEWPORTS,
	type LightThemeComplianceEntry,
	renderLightThemeComplianceShowcase,
} from "./fixtures/tui/light-theme-compliance-showcase";

interface ArtifactFile {
	path: string;
	sha256: string;
	byte_length: number;
}

interface ArtifactEntry {
	key: string;
	theme: string;
	scene_id: string;
	render_mode: string;
	theme_sentinel_sha256: string;
	files: ArtifactFile[];
}

interface ArtifactSourceFile {
	path: string;
	sha256: string;
	byte_length: number;
}

interface ArtifactManifest {
	schema_version: 1;
	source_revision: string;
	source_fingerprint: string;
	source_files: ArtifactSourceFile[];
	environment_id: string;
	expected_entry_count: number;
	entry_count: number;
	expected_leaf_count: number;
	leaf_count: number;
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

function readManifest(value: unknown): ArtifactManifest {
	if (!isRecord(value) || value.schema_version !== 1 || !Array.isArray(value.entries)) {
		throw new Error("Invalid light-theme manifest");
	}
	const entries: ArtifactEntry[] = value.entries.map((rawEntry, index) => {
		if (!isRecord(rawEntry) || !Array.isArray(rawEntry.files)) throw new Error(`Invalid manifest entry ${index}`);
		const files: ArtifactFile[] = rawEntry.files.map(rawFile => {
			if (
				!isRecord(rawFile) ||
				typeof rawFile.path !== "string" ||
				typeof rawFile.sha256 !== "string" ||
				typeof rawFile.byte_length !== "number"
			) {
				throw new Error(`Invalid artifact file in entry ${index}`);
			}
			return { path: rawFile.path, sha256: rawFile.sha256, byte_length: rawFile.byte_length };
		});
		for (const key of ["key", "theme", "scene_id", "render_mode", "theme_sentinel_sha256"] as const) {
			if (typeof rawEntry[key] !== "string") throw new Error(`Invalid ${key} in entry ${index}`);
		}
		return {
			key: rawEntry.key as string,
			theme: rawEntry.theme as string,
			scene_id: rawEntry.scene_id as string,
			render_mode: rawEntry.render_mode as string,
			theme_sentinel_sha256: rawEntry.theme_sentinel_sha256 as string,
			files,
		};
	});
	for (const key of ["source_revision", "source_fingerprint", "environment_id"] as const) {
		if (typeof value[key] !== "string" || value[key].length === 0) throw new Error(`Invalid manifest ${key}`);
	}
	if (!Array.isArray(value.source_files)) throw new Error("Invalid manifest source_files");
	const source_files: ArtifactSourceFile[] = value.source_files.map((rawFile, index) => {
		if (
			!isRecord(rawFile) ||
			typeof rawFile.path !== "string" ||
			typeof rawFile.sha256 !== "string" ||
			typeof rawFile.byte_length !== "number"
		) {
			throw new Error(`Invalid manifest source file ${index}`);
		}
		return { path: rawFile.path, sha256: rawFile.sha256, byte_length: rawFile.byte_length };
	});
	for (const key of ["expected_entry_count", "entry_count", "expected_leaf_count", "leaf_count"] as const) {
		if (typeof value[key] !== "number") throw new Error(`Invalid manifest ${key}`);
	}
	return {
		schema_version: 1,
		source_revision: value.source_revision as string,
		source_fingerprint: value.source_fingerprint as string,
		source_files,
		environment_id: value.environment_id as string,
		expected_entry_count: value.expected_entry_count as number,
		entry_count: value.entry_count as number,
		expected_leaf_count: value.expected_leaf_count as number,
		leaf_count: value.leaf_count as number,
		entries,
	};
}

function expectedLanguageKeys(sceneId: string): string[] {
	return LIGHT_THEME_COMPLIANCE_ENTRIES.filter(
		entry => entry.sceneId === sceneId && entry.renderMode === "unicode-color",
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

function validateIndependentReview(
	value: unknown,
	manifest: ArtifactManifest,
	manifestSha256: string,
	capturedAt: string,
): void {
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
	if (value.schema_version !== 1 || value.decision !== "pass") throw new Error("Review is not a schema-v1 pass");
	if (
		typeof value.reviewed_at !== "string" ||
		!value.reviewed_at.endsWith("Z") ||
		Number.isNaN(Date.parse(value.reviewed_at)) ||
		Date.parse(value.reviewed_at) < Date.parse(capturedAt)
	) {
		throw new Error("Review timestamp is invalid or predates capture");
	}
	if (
		!isRecord(value.reviewer) ||
		typeof value.reviewer.id !== "string" ||
		!value.reviewer.id ||
		typeof value.reviewer.role !== "string" ||
		!value.reviewer.role ||
		typeof value.reviewer.affiliation !== "string" ||
		!value.reviewer.affiliation
	) {
		throw new Error("Reviewer identity is incomplete");
	}
	if (!isRecord(value.independence)) throw new Error("Review independence is missing");
	const implementationAuthors = stringArray(value.independence.implementation_author_ids, "implementation authors");
	const captureAuthors = stringArray(value.independence.capture_author_ids, "capture authors");
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
		!/^[a-f0-9]{64}$/.test(manifestSha256)
	) {
		throw new Error("Review manifest path or SHA-256 mismatch");
	}
	for (const [key, expected] of [
		["source_revision", manifest.source_revision],
		["environment_id", manifest.environment_id],
		["expected_entry_count", 170],
		["observed_entry_count", 170],
		["expected_leaf_count", 850],
		["observed_leaf_count", 850],
	] as const) {
		if (value.manifest[key] !== expected) throw new Error(`Review manifest ${key} mismatch`);
	}
	if (!isRecord(value.inspection)) throw new Error("Review inspection is missing");
	const reviewedKeys = stringArray(value.inspection.reviewed_entry_keys, "reviewed keys").sort();
	const manifestKeys = manifest.entries.map(entry => entry.key).sort();
	if (
		reviewedKeys.length !== 170 ||
		new Set(reviewedKeys).size !== 170 ||
		reviewedKeys.join("\n") !== manifestKeys.join("\n")
	) {
		throw new Error("Review did not inspect the exact 170-key set");
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
			result.reviewed_entry_count !== 85 ||
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

describe("GJC light-theme compliance fixture", () => {
	it("defines the exact 170-key matrix without gaps or duplicates", () => {
		expect(LIGHT_THEME_COMPLIANCE_SCENE_IDS).toHaveLength(25);
		expect(LIGHT_THEME_COMPLIANCE_ENTRIES).toHaveLength(LIGHT_THEME_COMPLIANCE_EXPECTED_ENTRY_COUNT);
		expect(new Set(LIGHT_THEME_COMPLIANCE_ENTRIES.map(entry => entry.key)).size).toBe(170);
		for (const themeName of LIGHT_THEME_COMPLIANCE_THEMES) {
			expect(LIGHT_THEME_COMPLIANCE_ENTRIES.filter(entry => entry.theme === themeName)).toHaveLength(85);
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
		expect(atlasEntries).toHaveLength(6);
		expect(atlasEntries.map(entry => entry.viewport.columns).sort((a, b) => a - b)).toEqual([
			80, 80, 120, 120, 160, 160,
		]);
		for (const themeName of LIGHT_THEME_COMPLIANCE_THEMES) {
			const themeAtlas = atlasEntries.filter(entry => entry.theme === themeName);
			expect(themeAtlas).toHaveLength(3);
			expect(themeAtlas.map(entry => entry.viewport.columns).sort((a, b) => a - b)).toEqual([80, 120, 160]);
			expect(themeAtlas.every(entry => entry.renderMode === "unicode-color")).toBe(true);
		}
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
		expect(atlasEntries).toHaveLength(6);
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
	it.skipIf(!Bun.env.GJC_LIGHT_THEME_EVIDENCE)(
		"validates canonical evidence and the independent receipt fail-closed",
		async () => {
			const evidenceRoot = Bun.env.GJC_LIGHT_THEME_EVIDENCE!;
			const manifestPath = path.join(evidenceRoot, "manifest.json");
			const manifestBytes = new Uint8Array(await Bun.file(manifestPath).arrayBuffer());
			const manifest = readManifest(JSON.parse(new TextDecoder().decode(manifestBytes)) as unknown);
			const repoRoot = path.resolve(import.meta.dir, "../../..");
			const currentSource = await captureSourceFingerprint(repoRoot);
			expect(manifest.source_revision).toBe(currentSource.source_revision);
			expect(manifest.source_fingerprint).toBe(currentSource.source_fingerprint);
			expect(manifest.source_files).toEqual([...currentSource.source_files]);
			expect(manifest.expected_entry_count).toBe(170);
			expect(manifest.entry_count).toBe(170);
			expect(manifest.expected_leaf_count).toBe(850);
			expect(manifest.leaf_count).toBe(850);
			expect(new Set(manifest.entries.map(entry => entry.key)).size).toBe(170);
			expect(manifest.entry_count).toBe(manifest.entries.length);
			expect(manifest.leaf_count).toBe(manifest.entries.reduce((total, entry) => total + entry.files.length, 0));
			let observedLeaves = 0;
			for (const entry of manifest.entries) {
				expect(entry.files.map(file => path.basename(file.path)).sort()).toEqual(
					["metadata.json", "terminal-ansi.txt", "terminal.html", "terminal.png", "terminal.txt"].sort(),
				);
				for (const file of entry.files) {
					const bytes = new Uint8Array(await Bun.file(path.join(evidenceRoot, file.path)).arrayBuffer());
					expect(bytes.byteLength, file.path).toBe(file.byte_length);
					expect(sha256(bytes), file.path).toBe(file.sha256);
					observedLeaves += 1;
					if (file.path.endsWith("terminal.png")) {
						expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
					}
				}
				const metadataFile = entry.files.find(file => file.path.endsWith("metadata.json"))!;
				const metadata = JSON.parse(await Bun.file(path.join(evidenceRoot, metadataFile.path)).text()) as unknown;
				expect(isRecord(metadata)).toBe(true);
				if (isRecord(metadata)) {
					expect(metadata.environment_id).toBe(manifest.environment_id);
					expect(metadata.source_revision).toBe(manifest.source_revision);
					expect(isRecord(metadata.theme) ? metadata.theme.theme_sentinel_sha256 : undefined).toBe(
						entry.theme_sentinel_sha256,
					);
				}
			}
			expect(observedLeaves).toBe(850);
			const runReceipt = JSON.parse(await Bun.file(path.join(evidenceRoot, "run-receipt.json")).text()) as unknown;
			expect(isRecord(runReceipt)).toBe(true);
			if (!isRecord(runReceipt) || typeof runReceipt.captured_at !== "string") {
				throw new Error("Capture run receipt is missing captured_at");
			}
			const capturedAt = runReceipt.captured_at;
			expect(runReceipt.manifest_sha256).toBe(sha256(manifestBytes));
			expect(runReceipt.source_revision).toBe(manifest.source_revision);
			expect(runReceipt.environment_id).toBe(manifest.environment_id);
			const reviewPath = path.join(evidenceRoot, "independent-review.json");
			expect(await Bun.file(reviewPath).exists()).toBe(true);
			const review = JSON.parse(await Bun.file(reviewPath).text()) as unknown;
			validateIndependentReview(review, manifest, sha256(manifestBytes), capturedAt);
			if (!isRecord(review)) throw new Error("Independent review must be an object");
			const expectRejectedReview = (mutate: (candidate: Record<string, unknown>) => void): void => {
				const candidate = structuredClone(review);
				mutate(candidate);
				expect(() => validateIndependentReview(candidate, manifest, sha256(manifestBytes), capturedAt)).toThrow();
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
		},
		60_000,
	);
});
