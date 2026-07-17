import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startFixtureBrokerWithLeaseForTest } from "../../src/sdk/broker/ensure";
import {
	cleanupFixtureRoot,
	createFixtureBrokerEnvironment,
	createFixtureRootCleanup,
	withFixtureBrokerEnvironment,
} from "../helpers/fixture-broker-cleanup";

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

export function createHarnessCliEnv(repoRoot: string, baseEnv: NodeJS.ProcessEnv = process.env): HarnessCliEnv {
	const nodePathRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-harness-node-path-"));
	const packages = collectWorkspacePackages(repoRoot);
	linkWorkspacePackages(path.join(nodePathRoot, "@gajae-code"), packages);

	const existingNodePath = baseEnv.NODE_PATH;
	const env: NodeJS.ProcessEnv = {
		...baseEnv,
		[WORKSPACE_NODE_MODULES_ENV]: path.join(repoRoot, "node_modules"),
		NODE_PATH: existingNodePath ? `${nodePathRoot}${path.delimiter}${existingNodePath}` : nodePathRoot,
	};

	return {
		env,
		cleanup() {
			fs.rmSync(nodePathRoot, { recursive: true, force: true });
		},
	};
}

/**
 * Explicit fixture owner for CLI scenarios that launch detached children. The parent
 * retains the broker's sole lease; launched CLI processes receive only the isolated
 * attachment environment.
 */
export interface HarnessCliBrokerFixture {
	env: NodeJS.ProcessEnv;
	cleanup(): Promise<void>;
}

export async function createHarnessCliEnvWithFixtureBroker(
	repoRoot: string,
	fixtureRoot: string,
): Promise<HarnessCliBrokerFixture> {
	const agentDir = path.join(fixtureRoot, "agent");
	const linked = createHarnessCliEnv(repoRoot, createFixtureBrokerEnvironment(fixtureRoot, agentDir));
	linked.env.GJC_HARNESS_ROOT_REGISTRY_DIR = path.join(fixtureRoot, "root-registry");
	try {
		const started = await withFixtureBrokerEnvironment(() =>
			startFixtureBrokerWithLeaseForTest({ agentDir, env: linked.env }),
		);
		const rootCleanup = createFixtureRootCleanup(agentDir, agentDir, started.lease);

		return {
			env: linked.env,
			async cleanup() {
				await cleanupFixtureRoot(rootCleanup);
				linked.cleanup();
			},
		};
	} catch (error) {
		linked.cleanup();
		throw error;
	}
}
