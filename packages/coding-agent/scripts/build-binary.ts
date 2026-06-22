#!/usr/bin/env bun

import * as path from "node:path";

const packageDir = path.join(import.meta.dir, "..");
const outputPath = path.join(packageDir, "dist", "gjc");
const nativeDir = path.join(packageDir, "..", "natives", "native");

function shouldAdhocSignDarwinBinary(): boolean {
	return process.platform === "darwin";
}

async function runCommand(command: string[], env: NodeJS.ProcessEnv = Bun.env): Promise<void> {
	const proc = Bun.spawn(command, {
		cwd: packageDir,
		env,
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`Command failed with exit code ${exitCode}: ${command.join(" ")}`);
	}
}
async function stageWorkspaceNativeAddons(): Promise<void> {
	await Array.fromAsync(new Bun.Glob("pi_natives.*.node").scan({ cwd: nativeDir }), async filename => {
		await Bun.write(path.join(packageDir, "dist", filename), Bun.file(path.join(nativeDir, filename)));
	});
}

async function main(): Promise<void> {
	await runCommand(["bun", "--cwd=../stats", "scripts/generate-client-bundle.ts", "--generate"]);
	try {
		await runCommand(["bun", "--cwd=../natives", "run", "embed:native"]);
		try {
			const buildEnv = shouldAdhocSignDarwinBinary() ? { ...Bun.env, BUN_NO_CODESIGN_MACHO_BINARY: "1" } : Bun.env;
			await runCommand(
				[
					"bun",
					"build",
					"--compile",
					// Minify shrinks the bundled JS the compiled binary must parse at
					// startup (302MB → ~114MB --help RSS measured on darwin-arm64).
					// --keep-names below preserves identifiers for error reports.
					"--minify",
					"--no-compile-autoload-bunfig",
					"--no-compile-autoload-dotenv",
					"--no-compile-autoload-tsconfig",
					"--no-compile-autoload-package-json",
					"--keep-names",
					"--define",
					'process.env.PI_COMPILED="true"',
					"--external",
					"mupdf",
					"--root",
					"../..",
					"./src/cli.ts",
					// Worker entrypoints. Bun's `--compile` discovers the literal in
					// `new Worker("…", …)` at each spawn site, but only actually
					// emits the worker into the bunfs root when it is listed here as
					// an explicit additional entry. Paths are relative to this
					// script's cwd (packages/coding-agent) and the `--root` above
					// (../..) makes them appear inside the binary at
					// `/$bunfs/root/packages/<pkg>/src/<worker>.js`, which is
					// exactly what the literals at the spawn sites resolve to.
					"../stats/src/sync-worker.ts",
					"./src/tools/browser/tab-worker-entry.ts",
					"./src/eval/js/worker-entry.ts",
					// Hidden notify daemon CLI (loaded via dynamic import from notify-cli); list it
					// explicitly so Bun standalone keeps `gjc notify daemon-internal` usable.
					"./src/notifications/telegram-daemon-cli.ts",
					"--outfile",
					"dist/gjc",
				],
				buildEnv,
			);

			await stageWorkspaceNativeAddons();
			// Bun 1.3.12 emits a truncated Mach-O signature on darwin builds.
			if (shouldAdhocSignDarwinBinary()) {
				await runCommand(["codesign", "--force", "--sign", "-", outputPath]);
			}
		} finally {
			await runCommand(["bun", "--cwd=../natives", "run", "embed:native", "--reset"]);
		}
	} finally {
		await runCommand(["bun", "--cwd=../stats", "scripts/generate-client-bundle.ts", "--reset"]);
	}
}

await main();
