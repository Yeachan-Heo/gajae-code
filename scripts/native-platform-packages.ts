import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface NativePlatformPackage {
	packageDir: string;
	packageName: string;
	platformTag: string;
	files: string[];
}

export const nativePlatformPackages: NativePlatformPackage[] = [
	{
		packageDir: "packages/natives-linux-x64",
		packageName: "@gajae-code/natives-linux-x64",
		platformTag: "linux-x64",
		files: [
			"pi_natives.linux-x64-baseline.node",
			"pi_natives.linux-x64-modern.node",
			"pi_natives.linux-x64.node",
		],
	},
	{
		packageDir: "packages/natives-linux-arm64",
		packageName: "@gajae-code/natives-linux-arm64",
		platformTag: "linux-arm64",
		files: ["pi_natives.linux-arm64.node"],
	},
	{
		packageDir: "packages/natives-darwin-x64",
		packageName: "@gajae-code/natives-darwin-x64",
		platformTag: "darwin-x64",
		files: [
			"pi_natives.darwin-x64-baseline.node",
			"pi_natives.darwin-x64-modern.node",
			"pi_natives.darwin-x64.node",
		],
	},
	{
		packageDir: "packages/natives-darwin-arm64",
		packageName: "@gajae-code/natives-darwin-arm64",
		platformTag: "darwin-arm64",
		files: ["pi_natives.darwin-arm64.node"],
	},
	{
		packageDir: "packages/natives-win32-x64",
		packageName: "@gajae-code/natives-win32-x64",
		platformTag: "win32-x64",
		files: [
			"pi_natives.win32-x64-baseline.node",
			"pi_natives.win32-x64-modern.node",
			"pi_natives.win32-x64.node",
		],
	},
];

export function getNativePlatformPackage(platformTag: string): NativePlatformPackage | undefined {
	return nativePlatformPackages.find(pkg => pkg.platformTag === platformTag);
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

export async function syncNativePlatformPackages(repoRoot: string, options: { strict?: boolean } = {}): Promise<void> {
	const sourceDir = path.join(repoRoot, "packages/natives/native");
	for (const pkg of nativePlatformPackages) {
		const targetDir = path.join(repoRoot, pkg.packageDir, "native");
		await fs.mkdir(targetDir, { recursive: true });
		let copied = 0;
		for (const filename of pkg.files) {
			const sourcePath = path.join(sourceDir, filename);
			if (!(await pathExists(sourcePath))) continue;
			await fs.copyFile(sourcePath, path.join(targetDir, filename));
			copied += 1;
		}
		if (options.strict && copied === 0) {
			throw new Error(
				`No native addon files for ${pkg.packageName} (${pkg.platformTag}) found under ${sourceDir}. Expected one of: ${pkg.files.join(", ")}`,
			);
		}
	}
}
