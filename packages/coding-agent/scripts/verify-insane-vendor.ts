#!/usr/bin/env bun
/**
 * Vendor verification for packages/coding-agent/vendor/insane-search.
 *
 * Asserts:
 *   1. Forbidden upstream paths/patterns are absent (install hooks, star-baiting,
 *      update-notifier, transcript-language scanner, .claude-plugin).
 *   2. MANIFEST.json exists and pins a full 40-char upstream commit SHA.
 *   3. The vendored runtime files are present.
 *   4. `npm pack --dry-run --json` includes the vendor tree (engine entrypoint,
 *      templates, LICENSE, manifest) in the published package.
 *
 * Exit code 0 on success, 1 on any failure.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = join(pkgDir, "vendor", "insane-search");
const failures: string[] = [];

function fail(msg: string): void {
	failures.push(msg);
}

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...walk(full));
		else out.push(full);
	}
	return out;
}

// 1. Forbidden paths / patterns
if (!existsSync(vendorDir)) {
	fail(`vendor tree missing at ${vendorDir}`);
} else {
	const files = walk(vendorDir).map(f => relative(vendorDir, f));
	const forbiddenNames = ["setup.sh", "gptaku-update-check.cjs"];
	const forbiddenSubpaths = [".claude-plugin/", "/references/", "/tests/coverage_battery"];
	for (const f of files) {
		const base = f.split("/").pop() ?? f;
		if (forbiddenNames.includes(base)) fail(`forbidden file present: ${f}`);
		for (const sub of forbiddenSubpaths) {
			if (`/${f}`.includes(sub)) fail(`forbidden path present: ${f}`);
		}
	}
	// Scan for star-baiting / settings.json mutation / transcript scanning patterns.
	const forbiddenPatterns: Array<[RegExp, string]> = [
		[/user\/starred/, "github star-baiting (user/starred)"],
		[/gh\s+api\s+-X\s+PUT/, "gh api star write"],
		[/SessionStart/, "settings.json SessionStart hook injection"],
		[/\.claude\/projects/, "past-session transcript scanner"],
	];
	for (const f of files) {
		if (f === "MANIFEST.json") continue; // manifest documents the excluded patterns by name
		let body = "";
		try {
			body = readFileSync(join(vendorDir, f), "utf8");
		} catch {
			continue;
		}
		for (const [re, label] of forbiddenPatterns) {
			if (re.test(body)) fail(`forbidden pattern (${label}) found in ${f}`);
		}
	}
}

// 2. Manifest with pinned SHA
const manifestPath = join(vendorDir, "MANIFEST.json");
let commit = "";
if (!existsSync(manifestPath)) {
	fail("MANIFEST.json missing");
} else {
	try {
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
			upstream?: { commit?: string };
		};
		commit = manifest.upstream?.commit ?? "";
		if (!/^[0-9a-f]{40}$/.test(commit)) fail(`MANIFEST upstream.commit is not a full 40-char SHA: "${commit}"`);
	} catch (err) {
		fail(`MANIFEST.json is not valid JSON: ${(err as Error).message}`);
	}
}

// 3. Required runtime files present
const requiredFiles = [
	"engine/__main__.py",
	"engine/__init__.py",
	"engine/fetch_chain.py",
	"engine/templates/package.json",
	"engine/templates/playwright_real_chrome.js",
	"engine/waf_profiles.yaml",
	"LICENSE",
	"MANIFEST.json",
];
for (const rel of requiredFiles) {
	if (!existsSync(join(vendorDir, rel))) fail(`required vendored file missing: ${rel}`);
}

// 4. Package pack inclusion
try {
	const raw = execFileSync("npm", ["pack", "--dry-run", "--json"], {
		cwd: pkgDir,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	const parsed = JSON.parse(raw) as Array<{ files?: Array<{ path: string }> }>;
	const packed = new Set((parsed[0]?.files ?? []).map(f => f.path.replace(/\\/g, "/")));
	const mustPack = [
		"vendor/insane-search/engine/__main__.py",
		"vendor/insane-search/engine/templates/playwright_real_chrome.js",
		"vendor/insane-search/LICENSE",
		"vendor/insane-search/MANIFEST.json",
	];
	for (const rel of mustPack) {
		if (!packed.has(rel)) fail(`package pack does not include ${rel}`);
	}
} catch (err) {
	fail(`npm pack --dry-run failed: ${(err as Error).message}`);
}

if (failures.length > 0) {
	console.error("insane-vendor verification FAILED:");
	for (const f of failures) console.error(`  - ${f}`);
	process.exit(1);
}
console.log(`insane-vendor verification passed (pinned ${commit}).`);
