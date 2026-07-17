#!/usr/bin/env bun

/**
 * Canonical dev linker for the `gjc` CLI.
 *
 * Makes the global `gjc` command run THIS checkout's TypeScript source
 * (`packages/coding-agent/src/cli.ts`) instead of a compiled binary or a
 * published npm install. Running from source is the only mode that can
 * dynamically load `@gajae-code/natives` for skills — a `bun build --compile`
 * standalone binary cannot.
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
const targetDir = process.env.GJC_DEV_LINK_DIR ?? path.join(HOME, ".local", "bin");
const BUN_SHIM_VERSION = 5478;
const MAX_BUN_SHIM_METADATA_BYTES = 64 * 1024;
const MAX_BUN_SHIM_EXECUTABLE_BYTES = 1024 * 1024;
const EXPECTED_WORKSPACE_WRAPPER = '#!/usr/bin/env bun\nimport { runCli } from "@gajae-code/coding-agent/cli";\n\nawait runCli(process.argv.slice(2));\n';

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

export function commandExtensions(platform = process.platform, pathext = process.env.PATHEXT): string[] {
	if (platform !== "win32") return [""];
	const values = (pathext ?? ".COM;.EXE;.BAT;.CMD")
		.split(";")
		.map(value => value.trim())
		.filter(Boolean)
		.map(value => (value.startsWith(".") ? value : `.${value}`));
	if (values.length === 0) return [".COM", ".EXE", ".BAT", ".CMD"];
	const seen = new Set<string>();
	return values.filter(value => {
		const key = value.toLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

export function pathDirs(envPath = process.env.PATH ?? "", platform = process.platform): string[] {
	return envPath.split(platform === "win32" ? ";" : ":").filter(Boolean);
}

function isOnPath(dir: string): boolean {
	const want = realpath(dir) ?? dir;
	return pathDirs().some(entry => (realpath(entry) ?? entry) === want);
}

export interface GjcHit {
	dir: string;
	file: string;
	real: string | null;
}

/** All `gjc` entries on PATH, in shell resolution order (first wins). */
export function findGjcOnPath(
	envPath = process.env.PATH ?? "",
	platform = process.platform,
	pathext = process.env.PATHEXT,
): GjcHit[] {
	const hits: GjcHit[] = [];
	const seen = new Set<string>();
	for (const dir of pathDirs(envPath, platform)) {
		for (const extension of commandExtensions(platform, pathext)) {
			const file = path.join(dir, `gjc${extension}`);
			const key = platform === "win32" ? file.toLowerCase() : file;
			if (seen.has(key) || !lexists(file)) continue;
			seen.add(key);
			hits.push({ dir, file, real: realpath(file) });
		}
	}
	return hits;
}

function sameWindowsPath(left: string, right: string): boolean {
	return left.replaceAll("/", "\\").toLowerCase() === right.replaceAll("/", "\\").toLowerCase();
}

interface BunShimMetadata {
	target: string;
	command: string;
}

function decodeBunShimMetadata(metadata: Buffer): BunShimMetadata | null {
	if (metadata.length < 14 || metadata.length > MAX_BUN_SHIM_METADATA_BYTES || metadata.length % 2 !== 0) return null;
	const flags = metadata.readUInt16LE(metadata.length - 2);
	if ((flags >> 3) !== BUN_SHIM_VERSION || (flags & 0b111) !== 0b101) return null;
	const lengthsStart = metadata.length - 10;
	const binPathByteLength = metadata.readUInt32LE(lengthsStart);
	const argByteLength = metadata.readUInt32LE(lengthsStart + 4);
	if (
		binPathByteLength % 2 !== 0 ||
		argByteLength === 0 ||
		argByteLength % 2 !== 0 ||
		binPathByteLength + argByteLength + 14 !== metadata.length
	) {
		return null;
	}
	const framingStart = binPathByteLength;
	const commandStart = framingStart + 4;
	if (metadata.readUInt16LE(framingStart) !== 0x22 || metadata.readUInt16LE(framingStart + 2) !== 0) return null;
	try {
		const target = metadata.subarray(0, framingStart).toString("utf16le");
		const command = metadata.subarray(commandStart, lengthsStart).toString("utf16le");
		return command === "bun " ? { target, command } : null;
	} catch {
		return null;
	}
}

function readBoundedFile(file: string, maxBytes: number): Buffer | null {
	let descriptor: number | undefined;
	try {
		descriptor = fs.openSync(file, "r");
		const stat = fs.fstatSync(descriptor);
		if (!stat.isFile() || stat.size === 0 || stat.size > maxBytes) return null;
		const result = Buffer.alloc(stat.size);
		let offset = 0;
		while (offset < result.length) {
			const read = fs.readSync(descriptor, result, offset, result.length - offset, offset);
			if (read === 0) return null;
			offset += read;
		}
		const overflow = Buffer.alloc(1);
		if (fs.readSync(descriptor, overflow, 0, 1, offset) !== 0) return null;
		return result;
	} catch {
		return null;
	} finally {
		if (descriptor !== undefined) fs.closeSync(descriptor);
	}
}

function fileContainsBytes(file: string, needle: Buffer): boolean {
	let descriptor: number | undefined;
	try {
		const stat = fs.statSync(file);
		if (!stat.isFile() || stat.size < needle.length) return false;
		descriptor = fs.openSync(file, "r");
		const chunkBytes = 64 * 1024;
		const buffer = Buffer.alloc(chunkBytes + needle.length - 1);
		let overlap = 0;
		let position = 0;
		while (position < stat.size) {
			const read = fs.readSync(descriptor, buffer, overlap, chunkBytes, position);
			if (read === 0) return false;
			const total = overlap + read;
			if (buffer.subarray(0, total).indexOf(needle) !== -1) return true;
			overlap = Math.min(needle.length - 1, total);
			buffer.copy(buffer, 0, total - overlap, total);
			position += read;
		}
		return false;
	} catch {
		return false;
	} finally {
		if (descriptor !== undefined) fs.closeSync(descriptor);
	}
}

function isCompletePortableExecutable(file: Buffer): boolean {
	if (file.length < 0x40 || file[0] !== 0x4d || file[1] !== 0x5a) return false;
	const peOffset = file.readUInt32LE(0x3c);
	if (peOffset + 24 > file.length || file.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") return false;
	const sectionCount = file.readUInt16LE(peOffset + 6);
	const optionalHeaderBytes = file.readUInt16LE(peOffset + 20);
	if (sectionCount === 0 || sectionCount > 96) return false;
	const sectionTable = peOffset + 24 + optionalHeaderBytes;
	if (sectionTable + sectionCount * 40 > file.length) return false;
	let imageEnd = sectionTable + sectionCount * 40;
	for (let index = 0; index < sectionCount; index++) {
		const section = sectionTable + index * 40;
		const rawBytes = file.readUInt32LE(section + 16);
		const rawOffset = file.readUInt32LE(section + 20);
		if (rawOffset > file.length || rawBytes > file.length - rawOffset) return false;
		imageEnd = Math.max(imageEnd, rawOffset + rawBytes);
	}
	return imageEnd === file.length;
}

function isBunEmbeddedWindowsShim(file: string, bunExecutable: string): boolean {
	const shim = readBoundedFile(file, MAX_BUN_SHIM_EXECUTABLE_BYTES);
	return shim !== null && isCompletePortableExecutable(shim) && fileContainsBytes(bunExecutable, shim);
}

/**
 * Bun's Windows shim is a PE beside `<name>.bunx`. The latter is a bounded,
 * versioned UTF-16LE record; accepting the PE requires every local binding
 * below, never merely a successful command invocation.
 */
export function isLocalWindowsBunShim(file: string, root = repoRoot, bunExecutable = process.execPath): boolean {
	const expectedShim = path.join(root, "node_modules", ".bin", "gjc.exe");
	if (!sameWindowsPath(file, expectedShim)) return false;
	if (!isBunEmbeddedWindowsShim(expectedShim, bunExecutable)) return false;
	const metadata = readBoundedFile(`${expectedShim.slice(0, -4)}.bunx`, MAX_BUN_SHIM_METADATA_BYTES);
	const decoded = metadata ? decodeBunShimMetadata(metadata) : null;
	if (!decoded) return false;

	const packageRoot = path.join(root, "packages", "coding-agent");
	const packageManifest = path.join(packageRoot, "package.json");
	const wrapper = path.join(packageRoot, "bin", "gjc.js");
	let resolvedCli: string;
	let encodedTarget: string;
	try {
		const manifest: unknown = JSON.parse(fs.readFileSync(packageManifest, "utf8"));
		if (
			typeof manifest !== "object" ||
			manifest === null ||
			!("bin" in manifest) ||
			typeof manifest.bin !== "object" ||
			manifest.bin === null ||
			!("gjc" in manifest.bin) ||
			manifest.bin.gjc !== "bin/gjc.js"
		) {
			return false;
		}
		resolvedCli = Bun.resolveSync("@gajae-code/coding-agent/cli", root);
		encodedTarget = path.join(root, "node_modules", ...decoded.target.split(/[\\/]+/));
	} catch {
		return false;
	}
	return (
		realpath(encodedTarget) === realpath(wrapper) &&
		fs.readFileSync(wrapper, "utf8") === EXPECTED_WORKSPACE_WRAPPER &&
		realpath(resolvedCli) === realpath(path.join(packageRoot, "src", "cli.ts"))
	);
}

function describe(real: string | null): string {
	if (!real) return "broken symlink / unresolved";
	if (real === cliSourceReal) return "workspace source (cli.ts) — OK";
	if (/[/\\]dist[/\\]/.test(real)) return `compiled binary: ${real}`;
	if (real.includes("$bunfs")) return `compiled binary (bunfs): ${real}`;
	if (real.includes(`${path.sep}node_modules${path.sep}gajae-code${path.sep}`)) return `published wrapper: ${real}`;
	return real;
}

export function smokeTest(gjcPath: string): { ok: boolean; output: string } {
	const res = Bun.spawnSync([gjcPath, "--smoke-test"], { stdout: "pipe", stderr: "pipe" });
	const output = `${res.stdout.toString()}${res.stderr.toString()}`.trim();
	return { ok: res.exitCode === 0 && output.includes("smoke-test: ok"), output };
}

export function isApprovedWorkspaceSource(
	file: string,
	real: string | null,
	root = repoRoot,
	platform = process.platform,
	bunExecutable = process.execPath,
): boolean {
	const source = path.join(root, "packages", "coding-agent", "src", "cli.ts");
	return real === (realpath(source) ?? source) || (platform === "win32" && isLocalWindowsBunShim(file, root, bunExecutable));
}

function isApprovedSource(winner: GjcHit): boolean {
	return isApprovedWorkspaceSource(winner.file, winner.real);
}

function assertResolvedGjcIsSource(winner: GjcHit | undefined): void {
	if (!winner || isApprovedSource(winner)) return;
	console.error("");
	console.error("✗ Linked, but `gjc` still resolves to a different command earlier on PATH.");
	console.error(`  Resolved: ${winner.file}`);
	console.error(`       -> ${describe(winner.real)}`);
	console.error(`  Expected source: ${cliSourceReal}`);
	console.error(`  The managed link was created at: ${path.join(targetDir, "gjc")}`);
	console.error("  Move the managed link directory earlier on PATH or remove the shadowing command.");
	process.exit(1);
}

function assertWorkspaceLinksLocal(): void {
	const repoRootReal = realpath(repoRoot) ?? repoRoot;
	const scopeDir = path.join(repoRoot, "node_modules", "@gajae-code");
	let entries: string[];
	try {
		entries = fs.readdirSync(scopeDir);
	} catch {
		return;
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
		if (real && !real.startsWith(repoRootReal + path.sep)) stale.push({ link, real });
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
	if (fs.existsSync(cliSource)) return;
	console.error(`✗ Cannot find CLI source at ${cliSource}`);
	console.error("  Run this from the gajae-code checkout.");
	process.exit(1);
}

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
	console.log(`gjc resolves to: ${winner.file}`);
	console.log(`            -> ${describe(winner.real)}`);
	if (!isApprovedSource(winner)) {
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
	if (lexists(target)) fs.rmSync(target, { force: true });
	fs.symlinkSync(cliSource, target);
	console.log(`✓ Linked ${target} -> ${cliSource}`);
	if (!isOnPath(targetDir)) {
		console.warn(`! ${targetDir} is not on your PATH — add it so \`gjc\` resolves:`);
		console.warn(`    export PATH="${targetDir}:$PATH"`);
	}
	const repoBinShadow = path.join(repoRoot, "node_modules", ".bin", "gjc");
	for (const hit of findGjcOnPath()) {
		if (hit.file === target) break;
		if (hit.real === cliSourceReal) continue;
		if (realpath(hit.file) === realpath(repoBinShadow) || hit.file === repoBinShadow) {
			fs.rmSync(hit.file, { force: true });
			console.log(`✓ Removed in-repo shadow: ${hit.file}`);
			continue;
		}
		console.warn("");
		console.warn(`! A different \`gjc\` shadows the dev link (earlier on PATH): ${hit.file}`);
		console.warn(`    -> ${describe(hit.real)}`);
		console.warn(`    Remove it: rm "${hit.file}"`);
	}
	const winner = findGjcOnPath()[0];
	assertResolvedGjcIsSource(winner);
	const smoke = smokeTest(winner?.file ?? target);
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

if (import.meta.main) {
	if (process.argv.includes("--check")) check();
	else link();
}
