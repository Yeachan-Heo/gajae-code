import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface PackageManifest {
	name?: unknown;
}

export interface HarnessCliEnv {
	env: NodeJS.ProcessEnv;
	cleanup(): void;
}

function readPackageName(manifestPath: string): string | null {
	try {
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as PackageManifest;
		return typeof manifest.name === "string" ? manifest.name : null;
	} catch {
		return null;
	}
}

export function createHarnessCliEnv(repoRoot: string, baseEnv: NodeJS.ProcessEnv = process.env): HarnessCliEnv {
	const nodePathRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-harness-node-path-"));
	const scopeDir = path.join(nodePathRoot, "@gajae-code");
	fs.mkdirSync(scopeDir, { recursive: true });

	const packagesDir = path.join(repoRoot, "packages");
	for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const packageDir = path.join(packagesDir, entry.name);
		const name = readPackageName(path.join(packageDir, "package.json"));
		if (!name?.startsWith("@gajae-code/")) continue;
		const unscopedName = name.slice("@gajae-code/".length);
		fs.symlinkSync(packageDir, path.join(scopeDir, unscopedName), "dir");
	}

	const existingNodePath = baseEnv.NODE_PATH;
	const env: NodeJS.ProcessEnv = {
		...baseEnv,
		NODE_PATH: existingNodePath ? `${nodePathRoot}${path.delimiter}${existingNodePath}` : nodePathRoot,
	};

	return {
		env,
		cleanup() {
			fs.rmSync(nodePathRoot, { recursive: true, force: true });
		},
	};
}
