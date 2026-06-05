import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface PackageManifest {
	name?: unknown;
}

const WORKSPACE_NODE_MODULES_ENV = "GJC_HARNESS_TEST_NODE_MODULES";

interface LinkedWorkspacePackage {
	name: string;
	packageDir: string;
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

function collectWorkspacePackages(repoRoot: string): LinkedWorkspacePackage[] {
	const packagesDir = path.join(repoRoot, "packages");
	const packages: LinkedWorkspacePackage[] = [];
	for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const packageDir = path.join(packagesDir, entry.name);
		const name = readPackageName(path.join(packageDir, "package.json"));
		if (!name?.startsWith("@gajae-code/")) continue;
		packages.push({ name, packageDir });
	}
	return packages;
}

function linkWorkspacePackages(scopeDir: string, packages: LinkedWorkspacePackage[]): void {
	fs.mkdirSync(scopeDir, { recursive: true });
	for (const pkg of packages) {
		const unscopedName = pkg.name.slice("@gajae-code/".length);
		const linkPath = path.join(scopeDir, unscopedName);
		try {
			fs.symlinkSync(pkg.packageDir, linkPath, "dir");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
}

function createRepoNodeModulesLinks(repoRoot: string, packages: LinkedWorkspacePackage[]): () => void {
	const nodeModulesDir = path.join(repoRoot, "node_modules");
	const scopeDir = path.join(nodeModulesDir, "@gajae-code");
	const markerDir = path.join(nodeModulesDir, ".gjc-harness-test-links");
	const marker = path.join(markerDir, `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
	fs.mkdirSync(markerDir, { recursive: true });
	linkWorkspacePackages(scopeDir, packages);
	fs.writeFileSync(
		marker,
		JSON.stringify({ createdAt: new Date().toISOString(), packages: packages.map(pkg => pkg.name) }),
	);
	return () => {
		fs.rmSync(marker, { force: true });
		// Leave node_modules itself alone: it may be a real install. Remove only links
		// that still point at this repo's workspace packages and only after this test
		// process has released its marker. This keeps concurrent test files from
		// deleting each other's resolver surface.
		const activeMarkers = fs.existsSync(markerDir)
			? fs.readdirSync(markerDir).filter(name => name.endsWith(".json"))
			: [];
		if (activeMarkers.length > 0) return;
		for (const pkg of packages) {
			const unscopedName = pkg.name.slice("@gajae-code/".length);
			const linkPath = path.join(scopeDir, unscopedName);
			try {
				if (
					fs.lstatSync(linkPath).isSymbolicLink() &&
					fs.realpathSync(linkPath) === fs.realpathSync(pkg.packageDir)
				) {
					fs.rmSync(linkPath, { force: true });
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		fs.rmSync(markerDir, { recursive: true, force: true });
		try {
			fs.rmdirSync(scopeDir);
		} catch (error) {
			if (
				(error as NodeJS.ErrnoException).code !== "ENOENT" &&
				(error as NodeJS.ErrnoException).code !== "ENOTEMPTY"
			)
				throw error;
		}
		try {
			fs.rmdirSync(nodeModulesDir);
		} catch (error) {
			if (
				(error as NodeJS.ErrnoException).code !== "ENOENT" &&
				(error as NodeJS.ErrnoException).code !== "ENOTEMPTY"
			)
				throw error;
		}
	};
}

export function createHarnessCliEnv(repoRoot: string, baseEnv: NodeJS.ProcessEnv = process.env): HarnessCliEnv {
	const nodePathRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-harness-node-path-"));
	const packages = collectWorkspacePackages(repoRoot);
	linkWorkspacePackages(path.join(nodePathRoot, "@gajae-code"), packages);
	const cleanupRepoLinks = createRepoNodeModulesLinks(repoRoot, packages);

	const existingNodePath = baseEnv.NODE_PATH;
	const env: NodeJS.ProcessEnv = {
		...baseEnv,
		[WORKSPACE_NODE_MODULES_ENV]: path.join(repoRoot, "node_modules"),
		NODE_PATH: existingNodePath ? `${nodePathRoot}${path.delimiter}${existingNodePath}` : nodePathRoot,
	};

	return {
		env,
		cleanup() {
			cleanupRepoLinks();
			fs.rmSync(nodePathRoot, { recursive: true, force: true });
		},
	};
}
