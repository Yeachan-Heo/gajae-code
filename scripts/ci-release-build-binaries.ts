#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";

interface BinaryTarget {
	id: string;
	platform: string;
	arch: string;
	target: string;
	outfile: string;
}

const repoRoot = path.join(import.meta.dir, "..");
const binariesDir = path.join(repoRoot, "packages", "coding-agent", "binaries");
const entrypoint = "./packages/coding-agent/src/cli.ts";
// Worker entrypoints. Bun's `--compile` static analyzer discovers the
// literal in `new Worker("…", …)` at each spawn site, but only actually
// emits the worker into the bunfs root when it is also listed here as an
// explicit additional entry. Paths are repo-root-relative (matching
// `--root .` below) so the workers land at
// `/$bunfs/root/packages/<pkg>/src/<worker>.js`, which is exactly what the
// literals at the spawn sites resolve to. Keep this in sync with the dev
// script at `packages/coding-agent/scripts/build-binary.ts`; the
// `issue-1150-repro` test pins both halves of the contract.
const workerEntrypoints = [
	"./packages/stats/src/sync-worker.ts",
	"./packages/coding-agent/src/tools/browser/tab-worker-entry.ts",
	"./packages/coding-agent/src/eval/js/worker-entry.ts",
];
const isDryRun = process.argv.includes("--dry-run");
const targets: BinaryTarget[] = [
	{
		id: "darwin-arm64",
		platform: "darwin",
		arch: "arm64",
		target: "bun-darwin-arm64",
		outfile: "packages/coding-agent/binaries/gjc-darwin-arm64",
	},
	{
		id: "darwin-x64",
		platform: "darwin",
		arch: "x64",
		target: "bun-darwin-x64",
		outfile: "packages/coding-agent/binaries/gjc-darwin-x64",
	},
	{
		id: "linux-x64",
		platform: "linux",
		arch: "x64",
		target: "bun-linux-x64-baseline",
		outfile: "packages/coding-agent/binaries/gjc-linux-x64",
	},
	{
		id: "linux-arm64",
		platform: "linux",
		arch: "arm64",
		target: "bun-linux-arm64",
		outfile: "packages/coding-agent/binaries/gjc-linux-arm64",
	},
	{
		id: "win32-x64",
		platform: "win32",
		arch: "x64",
		target: "bun-windows-x64-modern",
		outfile: "packages/coding-agent/binaries/gjc-windows-x64.exe",
	},
];

function parseRequestedTargets(): Set<string> | null {
	const flagIndex = process.argv.findIndex(arg => arg === "--targets");
	const flagValue =
		flagIndex >= 0
			? process.argv[flagIndex + 1]
			: process.argv.find(arg => arg.startsWith("--targets="))?.split("=", 2)[1] ?? Bun.env.RELEASE_TARGETS;

	if (!flagValue) {
		return null;
	}

	return new Set(
		flagValue
			.split(",")
			.map(value => value.trim())
			.filter(Boolean),
	);
}

function hostDefaultTargets(): BinaryTarget[] {
	// A bare invocation (no --targets / RELEASE_TARGETS) is a single-host
	// dogfood build, not a full release. Only the host's platform/arch can be
	// built here because `embed:native` requires a matching prebuilt addon, and
	// cross-arch addons are produced per-runner in CI. Default to the host
	// target instead of every release target so we never demand native addons
	// for architectures this machine cannot produce.
	return targets.filter(target => target.platform === process.platform && target.arch === process.arch);
}

function shouldAdhocSignDarwinBinary(target: BinaryTarget): boolean {
	return target.platform === "darwin" && process.platform === "darwin";
}

async function runCommand(command: string[], cwd: string, env: NodeJS.ProcessEnv = Bun.env): Promise<void> {
	const proc = Bun.spawn(command, {
		cwd,
		env,
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`Command failed with exit code ${exitCode}: ${command.join(" ")}`);
	}
}

async function embedNative(target: BinaryTarget): Promise<void> {
	if (isDryRun) {
		console.log(`DRY RUN bun --cwd=packages/natives run embed:native [${target.platform}/${target.arch}]`);
		return;
	}

	await runCommand(["bun", "--cwd=packages/natives", "run", "embed:native"], repoRoot, {
		...Bun.env,
		TARGET_PLATFORM: target.platform,
		TARGET_ARCH: target.arch,
	});
}

async function buildBinary(target: BinaryTarget): Promise<void> {
	console.log(`Building ${target.outfile}...`);
	await embedNative(target);
	if (isDryRun) {
		const compileEntrypoints = workerEntrypoints.join(" ");
		console.log(`DRY RUN bun build --compile --minify --no-compile-autoload-bunfig --no-compile-autoload-dotenv --no-compile-autoload-tsconfig --no-compile-autoload-package-json --keep-names --define process.env.PI_COMPILED="true" --root . --external mupdf --target=${target.target} ${entrypoint} ${compileEntrypoints} --outfile ${target.outfile}`);
		return;
	}

	const buildEnv = shouldAdhocSignDarwinBinary(target)
		? { ...Bun.env, BUN_NO_CODESIGN_MACHO_BINARY: "1" }
		: Bun.env;
	await runCommand(
		[
			"bun",
			"build",
			"--compile",
			"--minify",
			"--no-compile-autoload-bunfig",
			"--no-compile-autoload-dotenv",
			"--no-compile-autoload-tsconfig",
			"--no-compile-autoload-package-json",
			"--keep-names",
			"--define",
			'process.env.PI_COMPILED="true"',
			"--root",
			".",
			"--external",
			"mupdf",
			"--target",
			target.target,
			entrypoint,
			...workerEntrypoints,
			"--outfile",
			target.outfile,
		],
		repoRoot,
		buildEnv,
	);

	// Bun 1.3.12 emits a truncated Mach-O signature on darwin builds.
	if (shouldAdhocSignDarwinBinary(target)) {
		await runCommand(["codesign", "--force", "--sign", "-", path.join(repoRoot, target.outfile)], repoRoot);
	}
}

async function generateBundle(): Promise<void> {
	if (isDryRun) {
		console.log("DRY RUN bun --cwd=packages/stats scripts/generate-client-bundle.ts --generate");
		return;
	}
	await runCommand(["bun", "--cwd=packages/stats", "scripts/generate-client-bundle.ts", "--generate"], repoRoot);
}

async function resetArtifacts(): Promise<void> {
	if (isDryRun) {
		console.log("DRY RUN bun --cwd=packages/natives run embed:native --reset");
		console.log("DRY RUN bun --cwd=packages/stats scripts/generate-client-bundle.ts --reset");
		return;
	}
	await runCommand(["bun", "--cwd=packages/natives", "run", "embed:native", "--reset"], repoRoot);
	await runCommand(["bun", "--cwd=packages/stats", "scripts/generate-client-bundle.ts", "--reset"], repoRoot);
}

async function main(): Promise<void> {
	const requestedTargets = parseRequestedTargets();
	const selectedTargets = requestedTargets
		? targets.filter(target => requestedTargets.has(target.id))
		: hostDefaultTargets();

	if (requestedTargets) {
		const unknownTargets = [...requestedTargets].filter(
			requestedTarget => !targets.some(target => target.id === requestedTarget),
		);
		if (unknownTargets.length > 0) {
			throw new Error(`Unknown release target(s): ${unknownTargets.join(", ")}`);
		}
	}

	if (selectedTargets.length === 0) {
		if (requestedTargets) {
			throw new Error("No release targets selected.");
		}
		throw new Error(
			`No release target matches this host (${process.platform}-${process.arch}). ` +
				`Pass --targets <id> or set RELEASE_TARGETS to build a specific target.`,
		);
	}

	await fs.mkdir(binariesDir, { recursive: true });
	await generateBundle();
	try {
		for (const target of selectedTargets) {
			await buildBinary(target);
		}
	} finally {
		await resetArtifacts();
	}
}

await main();
