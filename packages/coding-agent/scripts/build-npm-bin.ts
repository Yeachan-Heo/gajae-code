#!/usr/bin/env bun

import * as path from "node:path";

const packageDir = path.join(import.meta.dir, "..");
const outputPath = path.join(packageDir, "dist", "cli.js");
const shebang = "#!/usr/bin/env bun";

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

async function ensureShebang(): Promise<void> {
	const output = await Bun.file(outputPath).text();
	if (output.startsWith(`${shebang}\n`)) return;
	const withoutExistingShebang = output.startsWith("#!") ? output.replace(/^#!.*(?:\r?\n|$)/u, "") : output;
	await Bun.write(outputPath, `${shebang}\n${withoutExistingShebang}`);
}

async function main(): Promise<void> {
	await runCommand(["bun", "--cwd=../stats", "scripts/generate-client-bundle.ts", "--generate"]);
	try {
		await runCommand([
			"bun",
			"build",
			"./src/cli.ts",
			"--minify",
			"--keep-names",
			"--target=bun",
			"--external",
			"mupdf",
			"--outfile",
			"dist/cli.js",
		]);
		await ensureShebang();
	} finally {
		await runCommand(["bun", "--cwd=../stats", "scripts/generate-client-bundle.ts", "--reset"]);
	}
}

await main();
