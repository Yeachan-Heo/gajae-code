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

function executableNames(command: string): string[] {
	if (process.platform !== "win32") return [command];
	const extensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map(ext => ext.trim()).filter(Boolean);
	return [command, ...extensions.map(ext => `${command}${ext.toLowerCase()}`)];
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
		for (const name of executableNames("gjc")) {
			const file = path.join(dir, name);
			const key = process.platform === "win32" ? path.normalize(file).toLowerCase() : path.normalize(file);
			if (seen.has(key) || !lexists(file)) continue;
			seen.add(key);
			hits.push({ dir, file, real: realpath(file) });
			break;
		}
	}
	return hits;
}

function describe(hit: GjcHit): string {
	const real = hit.real;
	if (!real) return "broken symlink / unresolved";
	if (real === cliSourceReal) return "workspace source (cli.ts) — OK";
	if (resolvesToWorkspaceSource(hit.file)) return "workspace source (Bun shim) — OK";
	if (/[/\\]dist[/\\]/.test(real)) return `compiled binary: ${real}`;
	if (real.includes("$bunfs")) return `compiled binary (bunfs): ${real}`;
	if (real.includes(`${path.sep}node_modules${path.sep}gajae-code${path.sep}`)) return `published wrapper: ${real}`;
	return real;
}

function resolvesToWorkspaceSource(fromFile: string): boolean {
	try {
		const resolved = Bun.resolveSync("@gajae-code/coding-agent/cli", fromFile);
		return (realpath(resolved) ?? resolved) === cliSourceReal;
	} catch {
		return false;
	}
}

function isSourceHit(hit: GjcHit | undefined): boolean {
	return !!hit && (hit.real === cliSourceReal || resolvesToWorkspaceSource(hit.file));
}

function smokeTest(gjcPath: string): { ok: boolean; output: string } {
	const res = Bun.spawnSync([gjcPath, "--smoke-test"], { stdout: "pipe", stderr: "pipe" });
	const output = `${res.stdout.toString()}${res.stderr.toString()}`.trim();
	return { ok: res.exitCode === 0 && output.includes("smoke-test: ok"), output };
}

function assertResolvedGjcIsSource(winner: GjcHit | undefined): void {
	if (!winner || isSourceHit(winner)) return;

	console.error("");
	console.error("✗ Linked, but `gjc` still resolves to a different command earlier on PATH.");
	console.error(`  Resolved: ${winner.file}`);
	console.error(`       -> ${describe(winner)}`);
	console.error(`  Expected source: ${cliSourceReal}`);
	console.error(`  The managed link was created at: ${path.join(targetDir, "gjc")}`);
	console.error("  Move the managed link directory earlier on PATH or remove the shadowing command.");
	process.exit(1);
}

/**
 * Guard: `bun install` run from another worktree rewrites the
 * `node_modules/@gajae-code/*` workspace symlinks to point at THAT checkout,
 * and a later `bun install` here won't repair them (name+version still match,
 * so bun considers the install satisfied). Fail loudly instead of letting the
 * build break with confusing missing-export errors.
 */
function assertWorkspaceLinksLocal(): void {
	const repoRootReal = realpath(repoRoot) ?? repoRoot;
	const scopeDir = path.join(repoRoot, "node_modules", "@gajae-code");
	let entries: string[];
	try {
		entries = fs.readdirSync(scopeDir);
	} catch {
		return; // no install yet — nothing to validate
	}

	const stale: Array<{ link: string; real: string }> = [];
	for (const entry of entries) {
		const link = path.join(scopeDir, entry);
		try {
			if (!fs.lstatSync(link).isSymbolicLink()) continue;
		} catch {
			continue;
		}
		const real = realpath(link);
		if (real && !real.startsWith(repoRootReal + path.sep)) {
			stale.push({ link, real });
		}
	}

	if (stale.length === 0) return;

	console.error("✗ Workspace symlinks point outside this checkout (stale cross-worktree install):");
	for (const { link, real } of stale) {
		console.error(`    ${link}`);
		console.error(`      -> ${real}`);
	}
	console.error("  Fix: rm -rf node_modules/@gajae-code && bun install");
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
	assertWorkspaceLinksLocal();
	const hits = findGjcOnPath();
	if (hits.length === 0) {
		console.error("✗ `gjc` is not on PATH.");
		console.error("  Fix: bun run dev:link");
		process.exit(1);
	}

	const winner = hits[0];
	const onSource = isSourceHit(winner);
	console.log(`gjc resolves to: ${winner.file}`);
	console.log(`            -> ${describe(winner)}`);

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
	assertWorkspaceLinksLocal();

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

	// The repo's own `node_modules/.bin/gjc` is recreated by every `bun install`
	// and sits earlier on PATH, so remove it automatically instead of nagging.
	const repoBinShadow = path.join(repoRoot, "node_modules", ".bin", "gjc");

	// Warn about any drifted `gjc` that shadows the link (earlier on PATH).
	for (const hit of findGjcOnPath()) {
		if (hit.file === target) break; // our link wins from here on
		if (isSourceHit(hit)) continue; // another correct source link — harmless
		if (realpath(hit.file) === realpath(repoBinShadow) || hit.file === repoBinShadow) {
			fs.rmSync(hit.file, { force: true });
			console.log(`✓ Removed in-repo shadow: ${hit.file}`);
			continue;
		}
		console.warn("");
		console.warn(`! A different \`gjc\` shadows the dev link (earlier on PATH): ${hit.file}`);
		console.warn(`    -> ${describe(hit)}`);
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
