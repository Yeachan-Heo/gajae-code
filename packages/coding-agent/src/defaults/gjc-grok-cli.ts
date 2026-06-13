import * as path from "node:path";

export function getBundledGrokBuildExtensionPath(): string {
	return path.join(import.meta.dir, "gjc", "extensions", "grok-build", "index.ts");
}

export function getBundledGrokBuildExtensionDir(): string {
	return path.dirname(getBundledGrokBuildExtensionPath());
}

export function getBundledGrokCliVendorDir(): string {
	return path.join(import.meta.dir, "gjc", "extensions", "grok-cli-vendor");
}

export function getBundledGrokCliModelDefaultsPath(): string {
	return path.join(import.meta.dir, "gjc", "agent.models.grok-cli.yml");
}

export async function assertBundledGrokCliDefaults(): Promise<void> {
	const required = [
		getBundledGrokBuildExtensionPath(),
		path.join(getBundledGrokCliVendorDir(), "src", "index.ts"),
		path.join(getBundledGrokCliVendorDir(), "src", "provider", "register.ts"),
		getBundledGrokCliModelDefaultsPath(),
	];
	for (const filePath of required) {
		if (!(await Bun.file(filePath).exists())) {
			throw new Error(`Bundled Grok Build default is missing: ${filePath}`);
		}
	}
}

export async function getBundledGrokBuildExtensionPaths(): Promise<string[]> {
	await assertBundledGrokCliDefaults();
	return [getBundledGrokBuildExtensionPath()];
}
