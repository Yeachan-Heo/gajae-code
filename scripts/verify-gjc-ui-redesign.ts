#!/usr/bin/env bun

import * as path from "node:path";

interface GateResult {
	name: string;
	passed: boolean;
	details: string[];
}

const repoRoot = path.join(import.meta.dir, "..");

const results: GateResult[] = [
	await verifyThemeDefaults(),
	await verifyStatusDefaults(),
	await verifyExportBranding(),
	await verifyDocsBranding(),
];

for (const result of results) {
	console.log(`${result.passed ? "PASS" : "FAIL"} ${result.name}`);
	for (const detail of result.details) console.log(`  - ${detail}`);
}

const failed = results.filter(result => !result.passed);
if (failed.length > 0) {
	console.error(`\nGJC UI redesign verification failed: ${failed.map(result => result.name).join(", ")}`);
	process.exit(1);
}

console.log("\nGJC UI redesign verification passed.");

async function verifyThemeDefaults(): Promise<GateResult> {
	const settings = await readText("packages/coding-agent/src/config/settings-schema.ts");
	const themeRuntime = await readText("packages/coding-agent/src/modes/theme/theme.ts");
	const redClaw = await readJson("packages/coding-agent/src/modes/theme/defaults/red-claw.json");
	const blueCrab = await readJson("packages/coding-agent/src/modes/theme/defaults/blue-crab.json");
	const defaultIndex = await readText("packages/coding-agent/src/modes/theme/defaults/index.ts");
	const colors = isRecord(redClaw.colors) ? redClaw.colors : {};
	const vars = isRecord(redClaw.vars) ? redClaw.vars : {};

	const semanticPairs = [
		["accent", "error"],
		["accent", "warning"],
		["accent", "toolDiffRemoved"],
		["error", "warning"],
		["error", "toolDiffRemoved"],
	] as const;
	const semanticFindings = semanticPairs
		.filter(([left, right]) => resolveColor(colors[left], vars) === resolveColor(colors[right], vars))
		.map(([left, right]) => `${left} matches ${right}`);

	const expectedBuiltIns = ["blue-crab", "claude-code", "codex", "gruvbox-dark", "opencode", "red-claw"];
	const retainedBuiltIns =
		[...defaultIndex.matchAll(/^import /gm)].length === expectedBuiltIns.length &&
		[...defaultIndex.matchAll(/^\t/gm)].length === expectedBuiltIns.length &&
		defaultIndex.includes('"blue-crab": blue_crab') &&
		defaultIndex.includes('"claude-code": claude_code') &&
		defaultIndex.includes("\tcodex,") &&
		defaultIndex.includes('"gruvbox-dark": gruvbox_dark') &&
		defaultIndex.includes("\topencode,") &&
		defaultIndex.includes('"red-claw": red_claw') &&
		!defaultIndex.includes("dark_") &&
		!defaultIndex.includes("light_") &&
		isRecord(blueCrab.colors);

	return {
		name: "red-claw/blue-crab theme defaults and semantic token split",
		passed:
			settings.includes('default: "red-claw"') &&
			settings.includes('default: "blue-crab"') &&
			themeRuntime.includes('autoDarkTheme: string = "red-claw"') &&
			themeRuntime.includes('autoLightTheme: string = "blue-crab"') &&
			retainedBuiltIns &&
			resolveColor(colors.accent, vars) === resolveColor(vars.claw, vars) &&
			resolveColor(colors.error, vars) === resolveColor(vars.dangerRed, vars) &&
			resolveColor(colors.warning, vars) === resolveColor(vars.warningAmber, vars) &&
			resolveColor(colors.toolDiffRemoved, vars) === resolveColor(vars.diffRemovalRed, vars) &&
			semanticFindings.length === 0,
		details: [
			`settings default red-claw: ${settings.includes('default: "red-claw"')}`,
			`settings default blue-crab: ${settings.includes('default: "blue-crab"')}`,
			`runtime autoDarkTheme red-claw: ${themeRuntime.includes('autoDarkTheme: string = "red-claw"')}`,
			`runtime autoLightTheme blue-crab: ${themeRuntime.includes('autoLightTheme: string = "blue-crab"')}`,
			`expected built-in themes (${expectedBuiltIns.join(", ")}): ${retainedBuiltIns}`,
			`semantic collisions: ${semanticFindings.join("; ") || "<none>"}`,
		],
	};
}

async function verifyStatusDefaults(): Promise<GateResult> {
	const presets = await readText("packages/coding-agent/src/modes/components/status-line/presets.ts");
	const defaultStart = presets.indexOf("default:");
	const minimalStart = presets.indexOf("minimal:");
	const compactStart = presets.indexOf("compact:");
	const fullStart = presets.indexOf("full:");
	const defaultBlock = defaultStart >= 0 && minimalStart > defaultStart ? presets.slice(defaultStart, minimalStart) : "";
	const compactBlock = compactStart >= 0 && fullStart > compactStart ? presets.slice(compactStart, fullStart) : "";
	const leftSegmentsByPreset = parsePresetLeftSegments(presets);
	const publicPresetUsesPi = Object.entries(leftSegmentsByPreset).filter(([, segments]) => segments.includes("pi"));
	const fullUsesGajae = leftSegmentsByPreset.full?.includes("gajae") === true;
	const nerdUsesGajae = leftSegmentsByPreset.nerd?.includes("gajae") === true;
	return {
		name: "default-visible status line identity",
		passed:
			defaultBlock.includes('separator: "slash"') &&
			!defaultBlock.includes('"pi"') &&
			compactBlock.includes('separator: "slash"') &&
			presets.includes('full: {') &&
			fullUsesGajae &&
			nerdUsesGajae &&
			publicPresetUsesPi.length === 0,
		details: [
			`default separator slash: ${defaultBlock.includes('separator: "slash"')}`,
			`default pi segment absent: ${!defaultBlock.includes('"pi"')}`,
			`full GJC identity present: ${fullUsesGajae}`,
			`nerd GJC identity present: ${nerdUsesGajae}`,
			`public pi preset absent: ${publicPresetUsesPi.length === 0}${
				publicPresetUsesPi.length > 0 ? ` (${publicPresetUsesPi.map(([name]) => name).join(", ")})` : ""
			}`,
		],
	};
}

function parsePresetLeftSegments(source: string): Record<string, string[]> {
	const result: Record<string, string[]> = {};
	const presetRegex = /\n\t([a-z_]+): \{[\s\S]*?leftSegments: \[([^\]]*)\]/g;
	for (const match of source.matchAll(presetRegex)) {
		const [, name, rawSegments] = match;
		if (!name || !rawSegments) continue;
		result[name] = [...rawSegments.matchAll(/"([^"]+)"/g)].map(segmentMatch => segmentMatch[1]).filter(Boolean);
	}
	return result;
}

async function verifyExportBranding(): Promise<GateResult> {
	const templateHtml = await readText("packages/coding-agent/src/export/html/template.html");
	const templateJs = await readText("packages/coding-agent/src/export/html/template.js");
	const generated = await readText("packages/coding-agent/src/export/html/template.generated.ts");
	return {
		name: "HTML export GJC branding",
		passed:
			templateHtml.includes("GJC Session Export") &&
			templateHtml.includes('content="gajae-code"') &&
			templateJs.includes("gajae-code · red-claw transcript") &&
			templateJs.includes("GJC / gajae-code") &&
			templateJs.includes('meta[name="gjc-url-params"]') &&
			templateJs.includes('meta[name="gjc-share-base-url"]') &&
			templateJs.includes("gjc-share:v1:sidebar-width") &&
			templateJs.includes('meta[name="pi-url-params"]') &&
			templateJs.includes('meta[name="pi-share-base-url"]') &&
			templateJs.includes("pi-share:v1:sidebar-width") &&
			generated.includes("GJC Session Export") &&
			generated.includes("tool-output"),
		details: [
			`title/meta branded: ${templateHtml.includes("GJC Session Export") && templateHtml.includes('content="gajae-code"')}`,
			`header product branded: ${templateJs.includes("GJC / gajae-code")}`,
			`GJC metadata/storage keys present: ${templateJs.includes('meta[name="gjc-url-params"]') && templateJs.includes('meta[name="gjc-share-base-url"]') && templateJs.includes("gjc-share:v1:sidebar-width")}`,
			`legacy metadata/storage fallback retained: ${templateJs.includes('meta[name="pi-url-params"]') && templateJs.includes('meta[name="pi-share-base-url"]') && templateJs.includes("pi-share:v1:sidebar-width")}`,
			`generated template refreshed: ${generated.includes("GJC Session Export")}`,
			`transcript tool content still present: ${generated.includes("tool-output")}`,
		],
	};
}

async function verifyDocsBranding(): Promise<GateResult> {
	const rootReadme = await readText("README.md");
	const packageReadme = await readText("packages/coding-agent/README.md");
	const themeDoc = await readText("docs/theme.md");
	return {
		name: "public docs current GJC crustacean theme direction",
		passed:
			rootReadme.includes("default dark TUI identity is the GJC red-claw theme") &&
			rootReadme.includes("light-appearance terminals default to the bundled blue-crab theme") &&
			packageReadme.includes("defaults to the bundled `red-claw`") &&
			packageReadme.includes("bundled `blue-crab` theme") &&
			themeDoc.includes('theme.dark = "red-claw"') &&
			themeDoc.includes('theme.light = "blue-crab"'),
		details: [
			`README GJC red-claw default: ${rootReadme.includes("default dark TUI identity is the GJC red-claw theme")}`,
			`README blue-crab light default: ${rootReadme.includes("light-appearance terminals default to the bundled blue-crab theme")}`,
			`package README default red-claw: ${packageReadme.includes("defaults to the bundled `red-claw`")}`,
			`package README default blue-crab: ${packageReadme.includes("bundled `blue-crab` theme")}`,
			`theme docs default red-claw: ${themeDoc.includes('theme.dark = "red-claw"')}`,
			`theme docs default blue-crab: ${themeDoc.includes('theme.light = "blue-crab"')}`,
		],
	};
}

async function readText(relativePath: string): Promise<string> {
	return await Bun.file(path.join(repoRoot, relativePath)).text();
}

async function readJson(relativePath: string): Promise<Record<string, unknown>> {
	const value = await Bun.file(path.join(repoRoot, relativePath)).json();
	return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveColor(value: unknown, vars: Record<string, unknown>): unknown {
	if (typeof value !== "string") return value;
	const key = value.startsWith("$") ? value.slice(1) : value;
	return key in vars ? vars[key] : value;
}
