#!/usr/bin/env bun

/**
 * Canonical dev linker for the `gjc` CLI.
 *
 * Makes the global `gjc` command run THIS checkout's TypeScript source
 * (`packages/coding-agent/src/cli.ts`) instead of a compiled binary or a
 * published npm install. Running from source is the only mode that can
 * dynamically load `@gajae-code/natives` for skills — a `bun build --compile`
 * standalone binary cannot, which surfaces as:
 *
 *   Failed to load skill: Cannot find module '@gajae-code/natives' from '/$bunfs/root/gjc'
 *
 * Usage:
 *   bun scripts/dev-link.ts            # link `gjc` -> src/cli.ts on PATH
 *   bun scripts/dev-link.ts --check    # doctor: fail if `gjc` has drifted
 *
 * Env:
 *   GJC_DEV_LINK_DIR   override the target bin dir (default ~/.local/bin)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");
const cliSource = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
const cliSourceReal = realpath(cliSource) ?? cliSource;

const HOME = os.homedir();
const PATH_SEP = process.platform === "win32" ? ";" : ":";
const targetDir = process.env.GJC_DEV_LINK_DIR ?? path.join(HOME, ".local", "bin");

function realpath(p: string): string | null {
	try {
		return fs.realpathSync(p);
	} catch {
		return null;
	}
}

/** Does the symlink/file exist (without following the link)? */
function lexists(p: string): boolean {
	try {
		fs.lstatSync(p);
		return true;
	} catch {
		return false;
	}
}

function pathDirs(): string[] {
	return (process.env.PATH ?? "").split(PATH_SEP).filter(Boolean);
}

function isOnPath(dir: string): boolean {
	const want = realpath(dir) ?? dir;
	return pathDirs().some(d => (realpath(d) ?? d) === want);
}

interface GjcHit {
	dir: string;
	file: string;
	real: string | null;
}

/** All `gjc` entries on PATH, in resolution order (first wins). */
function findGjcOnPath(): GjcHit[] {
	const hits: GjcHit[] = [];
	const seen = new Set<string>();
	for (const dir of pathDirs()) {
		const file = path.join(dir, "gjc");
		if (seen.has(file) || !lexists(file)) continue;
		seen.add(file);
		hits.push({ dir, file, real: realpath(file) });
	}
	return hits;
}

function describe(real: string | null): string {
	if (!real) return "broken symlink / unresolved";
	if (real === cliSourceReal) return "workspace source (cli.ts) — OK";
	if (/[/\\]dist[/\\]/.test(real)) return `compiled binary: ${real}`;
	if (real.includes("$bunfs")) return `compiled binary (bunfs): ${real}`;
	if (real.includes(`${path.sep}node_modules${path.sep}gajae-code${path.sep}`)) {
		return `published wrapper: ${real}`;
	}
	return real;
}

function smokeTest(gjcPath: string): { ok: boolean; output: string } {
	const res = Bun.spawnSync([gjcPath, "--smoke-test"], { stdout: "pipe", stderr: "pipe" });
	const output = `${res.stdout.toString()}${res.stderr.toString()}`.trim();
	return { ok: res.exitCode === 0 && output.includes("smoke-test: ok"), output };
}

function assertResolvedGjcIsSource(winner: GjcHit | undefined): void {
	if (!winner || winner.real === cliSourceReal) return;

	console.error("");
	console.error("✗ Linked, but `gjc` still resolves to a different command earlier on PATH.");
	console.error(`  Resolved: ${winner.file}`);
	console.error(`       -> ${describe(winner.real)}`);
	console.error(`  Expected source: ${cliSourceReal}`);
	console.error(`  The managed link was created at: ${path.join(targetDir, "gjc")}`);
	console.error("  Move the managed link directory earlier on PATH or remove the shadowing command.");
	process.exit(1);
}

function assertSourceExists(): void {
	if (!fs.existsSync(cliSource)) {
		console.error(`✗ Cannot find CLI source at ${cliSource}`);
		console.error("  Run this from the gajae-code checkout.");
		process.exit(1);
	}
}

/** Doctor: verify the `gjc` the shell resolves is this checkout's source. */
function check(): never {
	assertSourceExists();
	const hits = findGjcOnPath();
	if (hits.length === 0) {
		console.error("✗ `gjc` is not on PATH.");
		console.error("  Fix: bun run dev:link");
		process.exit(1);
	}

	const winner = hits[0];
	const onSource = winner.real === cliSourceReal;
	console.log(`gjc resolves to: ${winner.file}`);
	console.log(`            -> ${describe(winner.real)}`);

	if (!onSource) {
		console.error("");
		console.error("✗ `gjc` is NOT this checkout's source — it has drifted.");
		console.error(`  Expected: ${cliSourceReal}`);
		console.error("  Fix: bun run dev:link");
		process.exit(1);
	}

	const smoke = smokeTest(winner.file);
	if (!smoke.ok) {
		console.error("");
		console.error("✗ `gjc --smoke-test` failed (natives/worker did not load):");
		console.error(smoke.output.replace(/^/gm, "  "));
		console.error("  Fix: bun run dev:link  (and rebuild natives if needed: bun run build:native)");
		process.exit(1);
	}

	console.log("✓ gjc runs this checkout's source and natives load (smoke-test: ok).");
	process.exit(0);
}

/** Link: point `gjc` at this checkout's source on PATH. */
function link(): never {
	assertSourceExists();

	if (process.platform === "win32") {
		console.error("dev:link targets Unix-like systems (symlink into ~/.local/bin).");
		console.error("On Windows, install the dev CLI with Bun instead:");
		console.error("  bun --cwd=packages/coding-agent link");
		process.exit(1);
	}

	fs.mkdirSync(targetDir, { recursive: true });
	const target = path.join(targetDir, "gjc");

	if (lexists(target)) {
		fs.rmSync(target, { force: true });
	}
	fs.symlinkSync(cliSource, target);
	console.log(`✓ Linked ${target} -> ${cliSource}`);

	if (!isOnPath(targetDir)) {
		console.warn(`! ${targetDir} is not on your PATH — add it so \`gjc\` resolves:`);
		console.warn(`    export PATH="${targetDir}:$PATH"`);
	}

	// Warn about any drifted `gjc` that shadows the link (earlier on PATH).
	for (const hit of findGjcOnPath()) {
		if (hit.file === target) break; // our link wins from here on
		if (hit.real === cliSourceReal) continue; // another correct source link — harmless
		console.warn("");
		console.warn(`! A different \`gjc\` shadows the dev link (earlier on PATH): ${hit.file}`);
		console.warn(`    -> ${describe(hit.real)}`);
		if (hit.dir === path.join(HOME, ".bun", "bin")) {
			console.warn("    Remove the published global install: bun remove -g gajae-code");
		} else {
			console.warn(`    Remove it: rm "${hit.file}"`);
		}
	}

	const winner = findGjcOnPath()[0];
	assertResolvedGjcIsSource(winner);

	const smokePath = winner?.file ?? target;
	const smoke = smokeTest(smokePath);
	if (!smoke.ok) {
		console.error("");
		console.error("✗ Linked, but `gjc --smoke-test` failed (natives/worker did not load):");
		console.error(smoke.output.replace(/^/gm, "  "));
		console.error("  Try rebuilding natives: bun run build:native");
		process.exit(1);
	}
	console.log("✓ smoke-test: ok — `gjc` runs this checkout's source with natives loaded.");
	process.exit(0);
}

if (process.argv.includes("--check")) {
	check();
} else {
	link();
}
