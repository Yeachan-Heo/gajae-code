import * as fs from "node:fs/promises";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");

async function runCommand(command: string[]): Promise<void> {
	const child = Bun.spawn(command, { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
	const code = await child.exited;
	if (code !== 0) throw new Error(`${command[0]} failed with exit code ${code}`);
}

function filenameComponent(value: unknown, field: string): string {
	if (
		typeof value !== "string" ||
		!value ||
		value !== value.trim() ||
		value === "." ||
		value === ".." ||
		/[\x00-\x1f\x7f/\\:]/.test(value)
	) {
		throw new Error(`Tauri ${field} must be a nonempty, safe filename component`);
	}
	return value;
}

// Package the finalized signed app without invoking Tauri again: rebundling can
// modify sealed resources. The runner seam is only for filesystem/command tests.
export async function bundleDmg(root = ROOT, run: (command: string[]) => Promise<void> = runCommand): Promise<string> {
	const config = (await Bun.file(path.join(root, "src-tauri", "tauri.conf.json")).json()) as {
		productName?: unknown;
		version?: unknown;
	};
	const productName = filenameComponent(config.productName, "productName");
	const version = filenameComponent(config.version, "version");
	const bundleDirectory = path.join(root, "src-tauri", "target", "release", "bundle");
	const appName = `${productName}.app`;
	const app = path.join(bundleDirectory, "macos", appName);
	if (!(await fs.lstat(app)).isDirectory()) throw new Error(`Expected a bundled app directory at ${app}`);
	const outputDirectory = path.join(bundleDirectory, "dmg");
	const architecture = process.arch === "arm64" ? "aarch64" : process.arch;
	const output = path.join(outputDirectory, `${productName}_${version}_${architecture}.dmg`);
	await fs.mkdir(outputDirectory, { recursive: true });
	// Keep the temporary image on the output filesystem so publishing it is an
	// atomic rename. Never remove the output directory or other bundle artifacts.
	const staging = await fs.mkdtemp(path.join(outputDirectory, ".gjc-dmg-"));
	try {
		const volume = path.join(staging, "volume");
		await fs.mkdir(volume);
		const stagedApp = path.join(volume, appName);
		await fs.cp(app, stagedApp, { recursive: true, dereference: false, verbatimSymlinks: true });
		await fs.symlink("/Applications", path.join(volume, "Applications"));
		await run(["codesign", "--verify", "--deep", "--strict", stagedApp]);
		const image = path.join(staging, "disk.dmg");
		await run(["hdiutil", "create", "-volname", productName, "-srcfolder", volume, "-format", "UDZO", image]);
		await fs.rename(image, output);
		return output;
	} finally {
		await fs.rm(staging, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	if (process.platform !== "darwin") throw new Error("Desktop DMG packaging requires macOS.");
	const output = await bundleDmg();
	process.stdout.write(`Packaged signed app as ${output}\n`);
}
