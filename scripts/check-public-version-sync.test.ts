import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildDocsIndexOutput, checkLivePublicVersionSync, checkPublicVersionSync } from "./check-public-version-sync";

const tempRoots: string[] = [];

async function createRepo(files: Record<string, string>): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-public-version-sync-"));
	tempRoots.push(root);
	for (const [relativePath, content] of Object.entries(files)) {
		const filePath = path.join(root, relativePath);
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await Bun.write(filePath, content);
	}
	return root;
}

function rootPackage(version = "1.2.3"): string {
	return JSON.stringify(
		{
			workspaces: {
				catalog: {
					"@gajae-code/coding-agent": version,
					"gajae-code": version,
				},
			},
		},
		null,
		"\t",
	);
}

function packageJson(name: string, version = "1.2.3", homepage = "https://gajae-code.com"): string {
	return JSON.stringify({ name, version, homepage }, null, "\t");
}

async function addGeneratedDocsIndex(root: string): Promise<void> {
	const outputPath = path.join(root, "packages/coding-agent/src/internal-urls/docs-index.generated.ts");
	await fs.mkdir(path.dirname(outputPath), { recursive: true });
	await Bun.write(outputPath, await buildDocsIndexOutput(root));
}

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(root => fs.rm(root, { force: true, recursive: true })));
});

describe("public docs/site/version sync guard", () => {
	test("passes when package versions, homepage metadata, marketing docs, and generated docs index match", async () => {
		const root = await createRepo({
			"package.json": rootPackage(),
			"packages/coding-agent/package.json": packageJson("@gajae-code/coding-agent"),
			"packages/gajae-code/package.json": packageJson("gajae-code"),
			"README.md": "# Gajae-Code\n\n## Recent highlights\n",
			"docs/sdk.md": "# SDK\n\nCurrent docs.\n",
		});
		await addGeneratedDocsIndex(root);

		await expect(checkPublicVersionSync(root)).resolves.toEqual([]);
	});

	test("fails on package, catalog, homepage, stale marketing, and generated docs drift", async () => {
		const root = await createRepo({
			"package.json": rootPackage("1.2.3"),
			"packages/coding-agent/package.json": packageJson("@gajae-code/coding-agent", "1.2.3"),
			"packages/gajae-code/package.json": packageJson("gajae-code", "1.2.2", "https://example.invalid"),
			"README.md": "# Gajae-Code\n\n## New in 1.2.2\n",
			"docs/sdk.md": "# SDK\n",
			"packages/coding-agent/src/internal-urls/docs-index.generated.ts": "stale\n",
		});

		const violations = await checkPublicVersionSync(root);
		expect(violations.some(violation => violation.path === "packages/gajae-code/package.json" && violation.message.includes("version 1.2.2"))).toBe(true);
		expect(violations.some(violation => violation.path === "packages/gajae-code/package.json" && violation.message.includes("homepage"))).toBe(true);
		expect(violations.some(violation => violation.path === "package.json" && violation.message.includes("catalog gajae-code"))).toBe(true);
		expect(violations.some(violation => violation.path === "README.md" && violation.message.includes("Visible marketing version 1.2.2"))).toBe(true);
		expect(violations.some(violation => violation.path.includes("docs-index.generated.ts") && violation.message.includes("stale"))).toBe(true);
	});

	test("live check passes when public homepage version matches canonical package version", async () => {
		const root = await createRepo({
			"package.json": rootPackage("1.2.3"),
			"packages/coding-agent/package.json": packageJson("@gajae-code/coding-agent", "1.2.3"),
		});
		const fetchImpl = async () => new Response("<main>🦀 v1.2.3 · beta</main>");

		await expect(checkLivePublicVersionSync(root, fetchImpl)).resolves.toEqual([]);
	});

	test("live check sends a bounded timeout signal to the homepage fetch", async () => {
		const root = await createRepo({
			"package.json": rootPackage("1.2.3"),
			"packages/coding-agent/package.json": packageJson("@gajae-code/coding-agent", "1.2.3"),
		});
		let observedSignal: AbortSignal | undefined;
		const fetchImpl = async (_input: string | URL, init?: RequestInit) => {
			observedSignal = init?.signal ?? undefined;
			return new Response("<main>🦀 v1.2.3 · beta</main>");
		};

		await expect(checkLivePublicVersionSync(root, fetchImpl, 50)).resolves.toEqual([]);
		expect(observedSignal).toBeInstanceOf(AbortSignal);
	});

	test("live check fails when deployed homepage exposes a stale version", async () => {
		const root = await createRepo({
			"package.json": rootPackage("1.2.3"),
			"packages/coding-agent/package.json": packageJson("@gajae-code/coding-agent", "1.2.3"),
		});
		const fetchImpl = async () => new Response("<main>🦀 v1.2.2 · beta</main>");

		const violations = await checkLivePublicVersionSync(root, fetchImpl);
		expect(violations).toEqual([
			{
				path: "https://gajae-code.com",
				message: "Public homepage version 1.2.2 does not match canonical 1.2.3. Redeploy or update the public site metadata.",
			},
		]);
	});
});
