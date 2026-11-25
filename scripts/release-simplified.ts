#!/usr/bin/env bun
/**
 * Simplified release script that just bumps version and folds changelog fragments
 */

import { $, Glob } from "bun";
import { consumeFragments, foldFragmentsIntoChangelog, readPackageFragments } from "./changelog-fragments";
import { releasedChangelogContent } from "./release";


const changelogGlob = new Glob("packages/*/CHANGELOG.md");
const packageJsonGlob = new Glob("packages/*/package.json");
const cargoTomlGlob = new Glob("crates/*/Cargo.toml");

function git(args: readonly string[]) {
	return $`git -c core.fsmonitor=false -c core.untrackedCache=false ${args}`;
}

async function main() {
	const version = "0.22.1";
	const date = new Date().toISOString().split("T")[0];

	console.log("\n=== Simplified Release (Version Bump + Changelog Folding) ===\n");

	// 1. Update package versions
	console.log(`Updating package versions to ${version}…`);
	const pkgJsonPaths = await Array.fromAsync(packageJsonGlob.scan("."));

	// Filter out private packages
	const publicPkgPaths: string[] = [];
	const publicPackageVersions = new Set<string>();
	for (const pkgPath of pkgJsonPaths) {
		const pkgJson = await Bun.file(pkgPath).json();
		if (pkgJson.private) {
			console.log(`  Skipping ${pkgJson.name} (private)`);
			continue;
		}
		if (typeof pkgJson.version !== "string") throw new Error(`${pkgPath} is missing a string version`);
		publicPackageVersions.add(pkgJson.version);
		publicPkgPaths.push(pkgPath);
	}
	if (publicPackageVersions.size !== 1) {
		throw new Error(`Public packages must share one pre-release version, received ${[...publicPackageVersions].join(", ")}`);
	}
	const previousVersion = publicPackageVersions.values().next().value;
	if (previousVersion === undefined) throw new Error("No public packages found for release");

	await $`sd '"version": "[^"]+"' ${`"version": "${version}"`} ${publicPkgPaths}`;

	// Verify
	console.log("  Verifying versions:");
	for (const pkgPath of publicPkgPaths) {
		const pkgJson = await Bun.file(pkgPath).json();
		console.log(`    ${pkgJson.name}: ${pkgJson.version}`);
	}
	console.log();

	// 2. Update root catalog versions
	console.log("Updating root catalog versions...");
	let rootPkgRaw = await Bun.file("package.json").text();
	rootPkgRaw = rootPkgRaw.replace(
		/("@gajae-code\/[^"]+":\s*)"[^"]+"/g,
		`$1"${version}"`,
	);
	await Bun.write("package.json", rootPkgRaw);
	console.log("  Updated root catalog @gajae-code/* entries\n");

	// 3. Update Rust workspace version
	console.log(`Updating Rust workspace version to ${version}…`);
	await $`sd '^version = "[^"]+"' ${`version = "${version}"`} Cargo.toml`;
	const cargoToml = await Bun.file("Cargo.toml").text();
	const versionMatch = cargoToml.match(/^\[workspace\.package\][\s\S]*?^version = "([^"]+)"/m);
	if (versionMatch) {
		console.log(`  workspace: ${versionMatch[1]}`);
	}
	console.log();

	// 4. Bump pi-natives version sentinel
	console.log(`Bumping pi-natives version sentinel to v${version}…`);
	const sentinelJsId = version.replace(/[^A-Za-z0-9]/g, "_");
	const sentinelName = `__piNativesV${sentinelJsId}`;
	const sentinelFiles = [
		"crates/pi-natives/src/lib.rs",
		"packages/natives/native/index.d.ts",
		"packages/natives/native/index.js",
	];
	await $`sd '__piNativesV[A-Za-z0-9_]+' ${sentinelName} ${sentinelFiles}`;
	console.log(`  sentinel: ${sentinelName}\n`);

	// 5. Update changelogs
	console.log("Updating CHANGELOGs...");
	for await (const changelog of changelogGlob.scan(".")) {
		const content = await Bun.file(changelog).text();

		if (!content.includes("## [Unreleased]")) {
			console.log(`  Skipping ${changelog}: no [Unreleased] section`);
			continue;
		}

		const fragments = await readPackageFragments(changelog);
		const folded = foldFragmentsIntoChangelog(content, fragments, changelog);
		await Bun.write(changelog, releasedChangelogContent(folded, version, date, changelog));
		await consumeFragments(fragments);
		console.log(
			`  Updated ${changelog}${fragments.length > 0 ? ` (folded ${fragments.length} fragment(s))` : ""}`,
		);
	}
	console.log();

	// 6. Commit changes
	console.log(`Creating release commit…`);
	await git(["add", "-A"]);
	await git(["commit", "-m", `chore: bump version to ${version}`]);
	console.log(`  Committed\n`);

	// 7. Tag release
	console.log(`Tagging release as v${version}…`);
	await git(["tag", `-a`, `v${version}`, `-m`, `Release v${version}`]);
	console.log(`  Tagged\n`);

	// 8. Push
	console.log(`Pushing to origin…`);
	await git(["push", "origin", "main", `v${version}`]);
	console.log(`  Pushed\n`);

	console.log(`✓ Release v${version} prepared and pushed!`);
}

main().catch(err => {
	console.error("Error:", err);
	process.exit(1);
});
