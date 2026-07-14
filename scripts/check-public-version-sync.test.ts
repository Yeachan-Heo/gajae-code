import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildDocsIndexOutput, checkLivePublicVersionSync, checkPublicVersionSync } from "./check-public-version-sync";
import { canonicalJsonBytes, createExpectedEvidence, createFinalEvidence, expectedEvidenceSha256, PUBLIC_PACKAGE_DEFINITIONS } from "./release-evidence";

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
const SOURCE_SHA = "a".repeat(40);
const DIFFERENT_SOURCE_SHA = "e".repeat(40);
const GIT_API = "https://api.github.com/repos/Yeachan-Heo/gajae-code/git";

const LATEST_RELEASE_API = "https://api.github.com/repos/Yeachan-Heo/gajae-code/releases/latest";
const RELEASE_LIST_API = "https://api.github.com/repos/Yeachan-Heo/gajae-code/releases?per_page=100";
const RELEASE_LIST_PAGE_TWO_API = "https://api.github.com/repos/Yeachan-Heo/gajae-code/releases?per_page=100&page=2";
const TAG_API = `${GIT_API}/ref/tags/v1.2.3`;

const RELEASE_STATE_URL = "https://gajae-code.com/release-sync.json";
const RELEASE_URL = "https://github.com/Yeachan-Heo/gajae-code/releases/tag/v1.2.3";
const EXPECTED_ASSET_URL = "https://assets.example/gajae-release-packages-expected-v1.json";
const FINAL_ASSET_URL = "https://assets.example/gajae-release-packages-v1.json";

type MockFetchResponse = Response | string | Record<string, unknown> | unknown[];

function stableRelease(assets?: Array<{ name: string; browser_download_url: string }>): Record<string, unknown> {
	return {
		id: 123,
		tag_name: "v1.2.3",
		draft: false,
		prerelease: false,
		published_at: "2026-07-12T04:00:25.000Z",
		html_url: RELEASE_URL,
		assets: assets ?? [
			{ name: "gjc-linux-x64", browser_download_url: "https://assets.example/gjc-linux-x64" },
			{ name: "gjc-linux-arm64", browser_download_url: "https://assets.example/gjc-linux-arm64" },
			{ name: "gjc-darwin-arm64", browser_download_url: "https://assets.example/gjc-darwin-arm64" },
			{ name: "gjc-darwin-x64", browser_download_url: "https://assets.example/gjc-darwin-x64" },
			{ name: "gjc-windows-x64.exe", browser_download_url: "https://assets.example/gjc-windows-x64.exe" },
			{ name: "gajae-release-packages-expected-v1.json", browser_download_url: EXPECTED_ASSET_URL },
			{ name: "gajae-release-packages-v1.json", browser_download_url: FINAL_ASSET_URL },
		],
	};
}

function releaseState(version = "1.2.3", changelogPath = "packages/coding-agent/CHANGELOG.md", sourceCommit = SOURCE_SHA): string {
	return `${JSON.stringify(
		{
			generated_content_sha256: "b".repeat(64),
			release: {
				id: 123,
				published_at: "2026-07-12T04:00:25Z",
				tag: `v${version}`,
				url: `https://github.com/Yeachan-Heo/gajae-code/releases/tag/v${version}`,
				version,
			},
			schema_version: 1,
			source: {
				changelog_path: changelogPath,
				commit_sha: sourceCommit,
				repository: "Yeachan-Heo/gajae-code",
			},
		},
		null,
		2,
	)}\n`;
}

function productionEvidence(sourceCommit = SOURCE_SHA): { expected: string; final: string } {

	const tarballSha512 = "c".repeat(128);
	const expected = createExpectedEvidence({
		sourceCommit,
		releaseVersion: "1.2.3",
		packages: PUBLIC_PACKAGE_DEFINITIONS.map(definition => ({
			dir: definition.dir,
			name: definition.name,
			version: "1.2.3",
			tarball_sha512: tarballSha512,
			expected_sri: `sha512-${Buffer.from(tarballSha512, "hex").toString("base64")}`,
			manifest_sha256: "d".repeat(64),
			unpacked_size: 0,
			file_count: 0,
			internal_dependencies: {},
		})),
	});
	const final = createFinalEvidence(
		expected,
		expectedEvidenceSha256(expected),
		Object.fromEntries(expected.packages.map(record => [record.name, {
			registry_sri: record.expected_sri,
			registry_tarball_sha512: record.tarball_sha512,
			registry_manifest_sha256: record.manifest_sha256,
			registry_internal_dependencies: record.internal_dependencies,
		}])),
	);
	return {
		expected: canonicalJsonBytes(expected).toString("utf8"),
		final: canonicalJsonBytes(final).toString("utf8"),
	};
}

function liveResponses(
	release: Record<string, unknown>,
	state: string,
	evidence = productionEvidence(),
): Record<string, MockFetchResponse> {
	return {
		[LATEST_RELEASE_API]: release,
		[TAG_API]: { object: { sha: SOURCE_SHA, type: "commit" } },
		[EXPECTED_ASSET_URL]: evidence.expected,
		[FINAL_ASSET_URL]: evidence.final,
		[RELEASE_STATE_URL]: state,
	};
}

function mockFetch(
	responses: Record<string, MockFetchResponse>,
	observedSignals?: AbortSignal[],
	observedUrls?: string[],
): (input: string | URL, init?: RequestInit) => Promise<Response> {
	return async (input, init) => {
		if (init?.signal != null) observedSignals?.push(init.signal);
		observedUrls?.push(String(input));
		const response = responses[String(input)];
		if (response === undefined) return new Response("not found", { status: 404 });
		if (response instanceof Response) return response;
		return new Response(typeof response === "string" ? response : JSON.stringify(response));
	};
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
	test("fails closed on a symlink-loop filesystem error", async () => {
		const root = await createRepo({
			"package.json": rootPackage(),
			"packages/loop/.keep": "",
		});
		await fs.symlink("package.json", path.join(root, "packages/loop/package.json"));

		await expect(checkPublicVersionSync(root)).rejects.toMatchObject({ code: "ELOOP" });
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

	test("live check executes the production final-evidence validator against canonical deployed release state", async () => {
		const responses = liveResponses(stableRelease(), releaseState());

		await expect(checkLivePublicVersionSync("unused", mockFetch(responses), 50)).resolves.toEqual([]);
	});
	test("uses /releases/latest authority and ignores out-of-order paginated release lists", async () => {
		const responses = liveResponses(stableRelease(), releaseState());
		responses[RELEASE_LIST_API] = [
			{ ...stableRelease(), id: 124, published_at: "2026-07-13T04:00:25.000Z", tag_name: "v1.2.4" },
		];
		responses[RELEASE_LIST_PAGE_TWO_API] = [
			{ ...stableRelease(), id: 125, published_at: "2026-07-11T04:00:25.000Z", tag_name: "v1.2.5" },
		];
		const requestedUrls: string[] = [];

		await expect(checkLivePublicVersionSync("unused", mockFetch(responses, undefined, requestedUrls), 50)).resolves.toEqual([]);

		expect(requestedUrls[0]).toBe(LATEST_RELEASE_API);
		expect(requestedUrls).not.toContain(RELEASE_LIST_API);
		expect(requestedUrls).not.toContain(RELEASE_LIST_PAGE_TWO_API);
	});

	test("live check rejects draft or prerelease values from the latest-release authority", async () => {
		const responses = liveResponses({ ...stableRelease(), draft: true, prerelease: true }, releaseState());

		await expect(checkLivePublicVersionSync("unused", mockFetch(responses), 50)).resolves.toEqual([
			{
				path: LATEST_RELEASE_API,
				message: "Latest source release v1.2.3 must be published and non-prerelease.",
			},
		]);
	});

	test("live check peels an annotated release tag to its commit", async () => {
		const annotatedTagSha = "b".repeat(40);
		const responses = liveResponses(stableRelease(), releaseState());
		responses[TAG_API] = { object: { sha: annotatedTagSha, type: "tag" } };
		responses[`${GIT_API}/tags/${annotatedTagSha}`] = { object: { sha: SOURCE_SHA, type: "commit" } };

		await expect(checkLivePublicVersionSync("unused", mockFetch(responses), 50)).resolves.toEqual([]);
	});

	test("live check bounds annotated-tag peeling at four object lookups", async () => {
		const tagObjectShas = [
			"b".repeat(40),
			"c".repeat(40),
			"d".repeat(40),
			"e".repeat(40),
			"f".repeat(40),
		] as const;
		const responses = liveResponses(stableRelease(), releaseState());
		responses[TAG_API] = { object: { sha: tagObjectShas[0], type: "tag" } };
		responses[`${GIT_API}/tags/${tagObjectShas[0]}`] = { object: { sha: tagObjectShas[1], type: "tag" } };
		responses[`${GIT_API}/tags/${tagObjectShas[1]}`] = { object: { sha: tagObjectShas[2], type: "tag" } };
		responses[`${GIT_API}/tags/${tagObjectShas[2]}`] = { object: { sha: tagObjectShas[3], type: "tag" } };
		responses[`${GIT_API}/tags/${tagObjectShas[3]}`] = { object: { sha: tagObjectShas[4], type: "tag" } };
		const requestedUrls: string[] = [];

		await expect(checkLivePublicVersionSync("unused", mockFetch(responses, undefined, requestedUrls), 50)).resolves.toEqual([
			{
				path: GIT_API,
				message: "Tag v1.2.3 did not peel to a commit within four annotated-tag hops.",
			},
		]);
		expect(requestedUrls).toEqual([
			LATEST_RELEASE_API,
			TAG_API,
			`${GIT_API}/tags/${tagObjectShas[0]}`,
			`${GIT_API}/tags/${tagObjectShas[1]}`,
			`${GIT_API}/tags/${tagObjectShas[2]}`,
			`${GIT_API}/tags/${tagObjectShas[3]}`,
		]);
	});

	test("live check reports annotated-tag object lookup failures", async () => {
		const annotatedTagSha = "b".repeat(40);
		const responses = liveResponses(stableRelease(), releaseState());
		responses[TAG_API] = { object: { sha: annotatedTagSha, type: "tag" } };
		responses[`${GIT_API}/tags/${annotatedTagSha}`] = new Response("unavailable", { status: 503 });

		await expect(checkLivePublicVersionSync("unused", mockFetch(responses), 50)).resolves.toEqual([
			{
				path: GIT_API,
				message: "Annotated tag v1.2.3 lookup returned HTTP 503.",
			},
		]);
	});

	test("live check sends bounded timeout signals to every remote request", async () => {
		const signals: AbortSignal[] = [];
		const responses = liveResponses(stableRelease(), releaseState());

		await expect(checkLivePublicVersionSync("unused", mockFetch(responses, signals), 50)).resolves.toEqual([]);
		expect(signals).toHaveLength(5);
		for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal);
	});

	test("live check fails when explicit deployed release state is stale", async () => {
		const responses = liveResponses(stableRelease(), releaseState("1.2.2"));

		await expect(checkLivePublicVersionSync("unused", mockFetch(responses), 50)).resolves.toEqual([
			{
				path: RELEASE_STATE_URL,
				message: "Deployed release tag v1.2.2 does not match latest complete release v1.2.3.",
			},
		]);
	});

	test("live check rejects a valid deployed source commit that differs from the peeled release commit", async () => {
		const responses = liveResponses(stableRelease(), releaseState(undefined, undefined, DIFFERENT_SOURCE_SHA));

		await expect(checkLivePublicVersionSync("unused", mockFetch(responses), 50)).resolves.toEqual([
			{
				path: RELEASE_STATE_URL,
				message: "Deployed source commit does not match the latest complete release tag's peeled commit.",
			},
		]);
	});

	test("live check compares the deployed source changelog path with the canonical release path", async () => {
		const responses = liveResponses(stableRelease(), releaseState(undefined, "CHANGELOG.md"));

		await expect(checkLivePublicVersionSync("unused", mockFetch(responses), 50)).resolves.toEqual([
			{
				path: RELEASE_STATE_URL,
				message: "Deployed source changelog path CHANGELOG.md does not match canonical packages/coding-agent/CHANGELOG.md.",
			},
		]);
	});

	test("live check rejects a deployed state with a malformed source commit", async () => {
		const responses = liveResponses(stableRelease(), releaseState(undefined, undefined, "not-a-sha"));

		await expect(checkLivePublicVersionSync("unused", mockFetch(responses), 50)).resolves.toEqual([
			{
				path: RELEASE_STATE_URL,
				message: "Deployed release state contains an invalid release or source identity.",
			},
		]);
	});

	test("live check rejects a stable release without final package evidence before reading deployed state", async () => {
		const incompleteAssets = [
			{ name: "gjc-linux-x64", browser_download_url: "https://assets.example/gjc-linux-x64" },
			{ name: "gjc-linux-arm64", browser_download_url: "https://assets.example/gjc-linux-arm64" },
			{ name: "gjc-darwin-arm64", browser_download_url: "https://assets.example/gjc-darwin-arm64" },
			{ name: "gjc-darwin-x64", browser_download_url: "https://assets.example/gjc-darwin-x64" },
			{ name: "gjc-windows-x64.exe", browser_download_url: "https://assets.example/gjc-windows-x64.exe" },
			{ name: "gajae-release-packages-expected-v1.json", browser_download_url: EXPECTED_ASSET_URL },
		];
		const responses = liveResponses(stableRelease(incompleteAssets), releaseState());

		await expect(checkLivePublicVersionSync("unused", mockFetch(responses), 50)).resolves.toEqual([
			{
				path: LATEST_RELEASE_API,
				message: "Published release v1.2.3 is incomplete: missing gajae-release-packages-v1.json.",
			},
		]);
	});

	test("live check rejects malformed final evidence with the production validator", async () => {
		const evidence = productionEvidence();
		const responses = liveResponses(stableRelease(), releaseState(), { ...evidence, final: "{}\n" });

		const violations = await checkLivePublicVersionSync("unused", mockFetch(responses), 50);
		expect(violations).toHaveLength(1);
		expect(violations[0]).toMatchObject({ path: LATEST_RELEASE_API });
		expect(violations[0]!.message).toContain("Latest stable source release has invalid final package evidence: Release evidence:");
	});

	test("live check rejects canonical internally consistent evidence from another source commit", async () => {
		const responses = liveResponses(
			stableRelease(),
			releaseState(),
			productionEvidence(DIFFERENT_SOURCE_SHA),
		);

		await expect(checkLivePublicVersionSync("unused", mockFetch(responses), 50)).resolves.toEqual([
			{
				path: LATEST_RELEASE_API,
				message: "Latest stable source release has invalid final package evidence: Evidence source commit does not match the immutable release tag.",
			},
		]);
	});
});
