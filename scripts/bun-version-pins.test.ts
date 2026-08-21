import { describe, expect, test } from "bun:test";
import * as path from "node:path";

interface PackageManifest {
	packageManager?: string;
	engines?: { bun?: string };
	workspaces?: { catalog?: { "@types/bun"?: string } };
}

const rootDir = path.resolve(import.meta.dir, "..");

async function text(relativePath: string): Promise<string> {
	return Bun.file(path.join(rootDir, relativePath)).text();
}

async function manifest(relativePath: string): Promise<PackageManifest> {
	return Bun.file(path.join(rootDir, relativePath)).json();
}

function pinnedBunVersion(root: PackageManifest): string {
	const match = /^bun@(\d+\.\d+\.\d+)$/.exec(root.packageManager ?? "");
	if (!match) throw new Error(`Invalid packageManager Bun pin: ${root.packageManager ?? "missing"}`);
	return match[1]!;
}

function expectMatchesToEqual(source: string, pattern: RegExp, expected: string): void {
	const matches = [...source.matchAll(pattern)].map(match => match[1]);
	expect(matches.length).toBeGreaterThan(0);
	expect(new Set(matches)).toEqual(new Set([expected]));
}

describe("repository Bun version pins", () => {
	test("keeps package metadata and Bun types aligned", async () => {
		const root = await manifest("package.json");
		const version = pinnedBunVersion(root);
		expect(root.workspaces?.catalog?.["@types/bun"]).toBe(`^${version}`);

		const workspaceGlob = new Bun.Glob("packages/*/package.json");
		for await (const relativePath of workspaceGlob.scan({ cwd: rootDir, onlyFiles: true })) {
			const workspace = await manifest(relativePath);
			if (workspace.engines?.bun !== undefined) {
				expect(workspace.engines.bun, relativePath).toBe(`>=${version}`);
			}
		}
	});

	test("keeps CI, release, installer, documentation, and evidence pins aligned", async () => {
		const version = pinnedBunVersion(await manifest("package.json"));
		const exactWorkflowPaths = [
			".github/actions/build-native/action.yml",
			".github/workflows/ci.yml",
			".github/workflows/dev-ci.yml",
			".github/workflows/pr-validation.yml",
			".github/workflows/public-site-sync.yml",
		];

		for (const relativePath of exactWorkflowPaths) {
			const source = await text(relativePath);
			expectMatchesToEqual(source, /bun-version:\s*["']?(\d+\.\d+\.\d+)/g, version);
			const cachePins = [...source.matchAll(/\bbun-(\d+\.\d+\.\d+)-\$\{\{/g)].map(match => match[1]);
			if (cachePins.length > 0) expect(new Set(cachePins), relativePath).toEqual(new Set([version]));
		}

		expect(await text("Dockerfile")).toContain(`ARG BUN_VERSION=${version}`);
		expect(await text("docs/composer-codex-parity.md")).toContain(`mise x bun@${version} -- <command>`);
		expect(await text("packages/coding-agent/bench/perf-corpus-rlm-analysis.py")).toContain(
			`BUN_VERSION = "${version}"`,
		);
		expect(await text("scripts/install.sh")).toContain(`MIN_BUN_VERSION="${version}"`);
		expect(await text("scripts/install.ps1")).toContain(`$MinimumBunVersion = "${version}"`);
	});
});
